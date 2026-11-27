'use strict';

// Home's card in `#home-aside` (frontend/src/features/home/needs-you-card.tsx):
// it was the Needs you card, then Recent threads (#6816, #6785), and since
// 24 Nov 2026 (Homeroom mobile polish, 03) it is Recent activity: a sideways
// row of cards, one per project, each saying what is going on there and
// opening the Homeroom bot tab narrowed to it. The file, the component and
// the ids keep the names they had, because the looks' CSS knows the card by
// `#home-needs-card`.
//
//   1. It is drawn where the viewer has anything in the bot tab's lists, as
//      a section: its label line on the page, then the row.
//   2. Its numbers are the tab's own: the tab's two reads (readDesk), its
//      four lists and its ranking of projects (rankProjects), and they equal
//      the tab's bands once narrowed to the project (useAiLines).
//   3. A card is one link to `#homeroom-bot?project=<slug>`; See all is the
//      tab with every project. The notifications sheet keeps its own Recent
//      threads list.
//   4. Under the standard look a row of the kit answers the pointer, a
//      press and the keyboard (20 Nov 2026); a placeholder row does not.
//
// Run with: node --test tests/home-needs-you-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/home/needs-you-card.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// A source's code, without its comments (which tell its history in the old names).
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const thread = (threadId, extra = {}) => ({
  threadId,
  kind: 'change',
  number: threadId + 100,
  title: `Thread ${threadId}`,
  appSlug: 'plant-pal',
  appName: 'Plant Pal',
  lastAt: '2026-11-18T09:00:00.000Z',
  href: `#app/plant-pal/dev/changes/${threadId + 100}`,
  ...extra,
});

test('the island mounts it in a row of its own before Challenges', () => {
  const island = read('frontend/src/features/home/index.tsx');
  // It is mounted as soon as the viewer is known, so its place is held from
  // the first paint.
  assert.match(island, /const aside = viewer;/);
  assert.match(island, /<div id="home-row" className="home-row">\s*\{aside \? \(\s*<aside id="home-aside" className="home-aside">\s*<NeedsYouCard \/>\s*<\/aside>\s*\) : null\}\s*<ChallengesSection \/>\s*<\/div>/);
  assert.equal(island.match(/<ChallengesSection \/>/g).length, 1, 'Challenges is drawn once, in the row');
  // A row of its own, as wide as the column, placed right under Pinned projects.
  const css = read('public/css/app.css');
  assert.match(css, /html:root \.home-row > \.home-aside > \* \{ flex: 1 1 auto; min-width: 0; \}/);
  assert.match(css, /html:root #home-screen \.home-main > \.home-row \{ display: contents; \}/);
  assert.match(css, /html:root #home-screen \.home-row > \.home-aside \{ order: 1; \}/);
});

// The bot tab's two reads, as a member with work in four projects has them.
const APP = (slug, name) => ({ slug, name, icon_url: null, icon_emoji: null });
const PLANT = APP('plant-pal', 'Plant Pal');
const RUN = APP('run-club', 'Run Club');
const KITE = APP('kite-log', 'Kite log');
const BIRD = APP('bird-count', 'Bird count');
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const work = (stage, extra = {}) => ({ stage, ...extra });
const th = (threadId, app, group, at, extra = {}) => ({
  threadId, number: threadId, kind: 'request', title: `Thread ${threadId}`, app, change: null,
  href: `#app/${app.slug}/dev/issues/${threadId}`, group, work: work(group === 'live' ? 'live' : 'building'), at, ...extra,
});
const NEEDS = [
  { kind: 'proposal', id: 11, number: 11, title: 'Dark mode', app: PLANT, at: ago(30) },
  { kind: 'proposal', id: 12, number: 12, title: 'Watering log', app: PLANT, at: ago(240) },
  { kind: 'question', id: 13, number: 13, title: 'Which colours?', app: RUN, at: ago(90) },
];
const WORK = {
  private: [],
  needs: [],
  next: [th(21, RUN, 'next', ago(10)), th(22, PLANT, 'next', ago(600))],
  waiting: [th(31, KITE, 'waiting', ago(2000)), th(32, KITE, 'waiting', ago(3000)), th(33, PLANT, 'waiting', ago(5))],
  live: [th(41, BIRD, 'live', ago(1440))],
};

test('it is a section as Pinned apps is: its label line on the page, then the row of project cards', () => {
  const src = read(CARD);
  assert.match(src, /const drawn = cards \? cards\.length > 0 : !failed && hint > 0;/);
  assert.match(src, /if \(!drawn\) return null;/, 'somebody with nothing in any list sees no section');
  assert.match(src, /<section id="home-needs-card" aria-label=\{t\('home:needsCard\.eyebrow'\)\} data-projects=\{cards \? String\(cards\.length\) : undefined\}>/);
  // The label and See all are one link, to the tab with every project.
  assert.match(src, /<SectionHeading>\s*<WipHeadMore\s+id="home-needs-card-btn"\s+direction="right"\s+href=\{SEE_ALL_HREF\}/);
  assert.equal(loadTsx(CARD).SEE_ALL_HREF, '#homeroom-bot', 'every project: a plain address carries no filter');
  assert.match(src, /<span id="home-needs-card-title" className="wip-head-words">\{t\('home:needsCard\.eyebrow'\)\}<\/span>\s*<\/WipHeadMore>/);
  assert.match(src, /label=\{t\('home:needsCard\.seeAllLabel'\)\}\s+pill=\{t\('home:needsCard\.seeAll'\)\}/);
  assert.equal(message('home:needsCard.eyebrow'), 'Recent activity');
  assert.equal(message('home:needsCard.seeAll'), 'See all');
  assert.equal(message('home:needsCard.seeAllLabel'), 'See all recent activity', 'its name starts with the words on screen');
  // The row is the list; each card one item of it.
  assert.match(src, /<ul className="wip-activity-rail" aria-labelledby="home-needs-card-title">\s*\{cards\.map\(\(card\) => <li key=\{card\.app\.slug\}><ActivityCardLink card=\{card\} \/><\/li>\)\}/);
  // The thread list is gone from Home, its words with it.
  assert.doesNotMatch(code(CARD), /\/api\/me\/recent-threads|RecentThreadItem|wip-rows|data-recent-thread|openThreadsList/);
  const catalog = JSON.parse(read('frontend/locales/en/home.json'));
  assert.deepEqual(Object.keys(catalog).filter((k) => /^needsCard\.(kind|meta)/.test(k)), [], 'no message is left for a row that is gone');
});

test('the numbers are the bot tab\'s own: its two reads, its four lists and its ranking of projects', () => {
  const src = read(CARD);
  assert.match(src, /import \{ readDesk \} from '\.\.\/ai\/desk';/, 'the reads every Your work row shares, kept a short while');
  assert.match(src, /void readDesk\(\)\.then\(\(\{ work, needs \}\) => \{/);
  assert.doesNotMatch(code(CARD), /fetch\(|sharedJson|\/api\//, 'it asks for nothing of its own');
  assert.match(src, /return rankProjects\(rows, progress, waiting, live\)\.map\(/, 'counted once, by the tab\'s own function');
  const { activityCards } = loadTsx(CARD);
  const model = loadTsx('frontend/src/features/ai/model.ts');
  const cards = activityCards(NEEDS, WORK, NOW);
  const ranked = model.rankProjects(model.needsYou(NEEDS, WORK), model.inProgress(NEEDS, WORK), model.upNext(NEEDS, WORK), model.liveThisWeek(WORK, NOW));
  assert.deepEqual(cards.map(({ at, ...p }) => p), ranked.map((p) => ({ ...p })), 'the tally and the order are rankProjects\' own');
  assert.deepEqual(cards.map((c) => c.app.slug), ['plant-pal', 'run-club', 'kite-log', 'bird-count'], 'most that need you first, then in progress, waiting, name');
  assert.deepEqual(cards.map((c) => [c.needs, c.progress, c.waiting, c.live]), [[2, 1, 1, 0], [1, 1, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]);
  // When it was last active: the newest moment among the project's rows, in any list.
  assert.deepEqual(cards.map((c) => c.at), [ago(5), ago(10), ago(2000), ago(1440)]);
  // A read that failed draws no numbers rather than wrong ones.
  assert.equal(activityCards(null, WORK, NOW), null);
  assert.equal(activityCards(NEEDS, null, NOW), null);
  assert.deepEqual(activityCards([], { private: [], next: [], waiting: [], live: [] }, NOW), [], 'nothing in any list: no card');
});

test('each card says what the tab narrowed to its project says', () => {
  // The tab's own lines and counts (features/ai/lines.ts useAiLines), narrowed
  // to each project as the card's link narrows it: its Needs you band, its In
  // progress band (what is under way and what waits), and Done's this week.
  const { activityCards, stateLines } = loadTsx(CARD);
  const model = loadTsx('frontend/src/features/ai/model.ts');
  const { useAiLines } = loadTsx('frontend/src/features/ai/lines.ts');
  const { createElement: h, renderToHtml } = require('./lib/render-tsx');
  const rows = model.needsYou(NEEDS, WORK);
  const progress = model.inProgress(NEEDS, WORK);
  const waiting = model.upNext(NEEDS, WORK);
  const live = model.liveThisWeek(WORK, NOW);
  const tabFor = (slug) => {
    let out = null;
    function Probe() {
      const l = useAiLines({ ready: true, rows, owed: model.owedCount(rows), progress, waiting, live, openRow() {}, openThread() {}, picked: [slug] });
      out = { needs: l.needCount, progress: l.progressCount, week: l.weekCount, picked: l.picked };
      return null;
    }
    renderToHtml(h(Probe, {}));
    return out;
  };
  for (const card of activityCards(NEEDS, WORK, NOW)) {
    const tab = tabFor(card.app.slug);
    assert.deepEqual(tab.picked, [card.app.slug], `${card.app.slug}: the address picks it`);
    const said = Object.fromEntries(stateLines(card, 3).map((line) => [line.key === 'waiting' ? 'progress' : line.key, line.count]));
    assert.equal(said.needs || 0, tab.needs, `${card.app.slug}: Needs you`);
    assert.equal(said.progress || 0, tab.progress, `${card.app.slug}: In progress`);
    assert.equal(said.live || 0, tab.week, `${card.app.slug}: this week`);
  }
});

test('a card says up to two lines, what needs you first and in the accent, and a zero says nothing', () => {
  const { stateLines, STATE_IDS } = loadTsx(CARD);
  const tally = (needs, progress, waiting, live) => ({ needs, progress, waiting, live });
  assert.deepEqual(stateLines(tally(21, 2, 1, 2)), [{ key: 'needs', count: 21 }, { key: 'progress', count: 3 }], 'in progress is the tab\'s band: under way and waiting');
  assert.deepEqual(stateLines(tally(0, 0, 4, 2)), [{ key: 'waiting', count: 4 }, { key: 'live', count: 2 }], 'nothing under way: the same number says it waits');
  assert.deepEqual(stateLines(tally(1, 0, 0, 0)), [{ key: 'needs', count: 1 }]);
  assert.deepEqual(stateLines(tally(0, 0, 0, 3)), [{ key: 'live', count: 3 }]);
  assert.deepEqual(stateLines(tally(0, 0, 0, 0)), []);
  assert.equal(message(STATE_IDS.needs, { count: 21 }), '21 need you');
  assert.equal(message(STATE_IDS.needs, { count: 1 }), '1 needs you');
  assert.equal(message(STATE_IDS.progress, { count: 2 }), '2 in progress');
  assert.equal(message(STATE_IDS.waiting, { count: 1 }), '1 waiting on others');
  assert.equal(message(STATE_IDS.live, { count: 2 }), '2 live this week');
  // Drawn: the project's 40px tile and a chevron, its name 15px at 650, the
  // lines at 13px with the need in the accent, then when, 12px and muted.
  const html = renderComponent(CARD, 'ActivityCardLink', {
    card: { app: PLANT, needs: 21, progress: 2, waiting: 1, live: 2, at: new Date(Date.now() - 24 * 60000).toISOString() },
  });
  assert.match(html, /^<a class="wip-card wip-activity-card" href="#homeroom-bot\?project=plant-pal" data-home-activity="plant-pal">/, 'the whole card is one link, to the tab narrowed to it');
  assert.match(html, /<span aria-hidden="true" data-icon="[^"]+" class="app-icon-tile w-10 h-10 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg">/);
  assert.match(html, /<svg[^>]*class="wip-activity-chevron h-4 w-4 /);
  assert.match(html, /<b class="wip-item-title block truncate text-\[15px\] font-\[650\] leading-5">Plant Pal<\/b>/);
  // One look (25 Nov 2026): the count that asks for you carries the shared tag part.
  // What needs you is the one tag (@/components/ui/state-tag) in its needs-you state.
  assert.match(html, /<span data-state-tag="needs" class="one-tag one-tag-strong" data-home-activity-line="needs" data-ask="">21 need you<\/span>/);
  assert.match(html, /<span class="block truncate text-\[13px\] leading-\[18px\] text-zinc-500 dark:text-zinc-400" data-home-activity-line="progress">3 in progress<\/span>/);
  assert.doesNotMatch(html, /live this week/, 'two lines at most');
  assert.match(html, /<span class="wip-activity-when block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400"><time datetime="[^"]+" title="[^"]+">24m ago<\/time><\/span>/i);
  // Nothing needing the viewer: no blue line.
  const quiet = renderComponent(CARD, 'ActivityCardLink', { card: { app: KITE, needs: 0, progress: 0, waiting: 2, live: 0, at: null } });
  assert.doesNotMatch(quiet, /data-ask|text-violet/);
  assert.match(quiet, /data-home-activity-line="waiting">2 waiting on others</);
  assert.doesNotMatch(quiet, /<time/, 'no moment, no foot line');
});

test('while the lists are on its way the row holds its place, from what the last visit saw, and Home\'s first paint waits on nothing', () => {
  const src = read(CARD);
  const { NEEDS_HINT_KEY, HINT_CARDS } = loadTsx(CARD);
  assert.equal(NEEDS_HINT_KEY, 'homeroom:recent-activity', 'a count of cards, not of the threads the old key counted');
  assert.match(src, /const \[hint\] = useState\(readNeedsHint\);/);
  assert.match(src, /useEffect\(\(\) => \{ if \(cards\) writeNeedsHint\(cards\.length\); \}, \[cards\]\);/);
  assert.match(src, /if \(count > 0\) window\.localStorage\.setItem\(NEEDS_HINT_KEY, String\(count\)\);\s*else window\.localStorage\.removeItem\(NEEDS_HINT_KEY\);\s*window\.localStorage\.removeItem\(OLD_HINT_KEY\);/);
  assert.match(src, /const OLD_HINT_KEY = 'homeroom:recent-threads';/);
  // As many placeholder cards as the last visit drew, each the card's own shape, said once in words.
  assert.equal(HINT_CARDS, 8);
  assert.match(src, /<ul className="wip-activity-rail animate-pulse" data-loading="" role="status" aria-label=\{t\('home:grid\.loading'\)\}>\s*\{Array\.from\(\{ length: Math\.min\(hint, HINT_CARDS\) \}, \(_, i\) => <li key=\{i\}><CardSkeleton \/><\/li>\)\}/);
  // Read in an effect, after the card mounts, and again each time Home is shown.
  assert.match(src, /const shown = useVisibility\('home-screen', true\);/);
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!shown\) return undefined;/);
  assert.match(src, /\}, \[shown\]\);/);
  // Home mounts the card only once the viewer is known, so the prerender draws none of it.
  const island = read('frontend/src/features/home/index.tsx');
  assert.match(island, /const \[viewer, setViewer\] = useState\(false\);/);
  assert.equal(renderComponent(CARD, 'NeedsYouCard', {}), '', 'its first render, with nothing kept on the device, is nothing');
});

test('the heading leads to the tab, and the sheet keeps its own Recent threads list', () => {
  const src = read(CARD);
  assert.doesNotMatch(code(CARD), /notificationsSheetStore|openNotificationsSheet/, 'the card no longer opens the sheet');
  // The sheet reads its list itself, as it always did, and still offers the tab.
  const sheet = read('frontend/src/features/notifications/notifications-sheet.tsx');
  assert.match(sheet, /fetch\(`\/api\/me\/recent-threads\?\$\{params\.toString\(\)\}`/);
  assert.match(sheet, /aria-selected=\{tab === 'threads'\}/);
  assert.match(sheet, /if \(!open \|\| !wantedTab\) return;\s*setTab\(wantedTab\);\s*notificationsSheetStore\.set\(\{ tab: null \}\);/);
  // A card's address is the one a project's Workshop and Hub link to; the tab reads it.
  const address = loadTsx('frontend/src/features/ai/filter-address.ts');
  assert.equal(address.projectTabAddress('plant-pal'), '#homeroom-bot?project=plant-pal');
  assert.deepEqual(address.projectsOf('#homeroom-bot?project=plant-pal'), ['plant-pal']);
  assert.deepEqual(address.projectsOf('#homeroom-bot'), [], 'See all: every project');
});

test('the row scrolls sideways from the page\'s gutter and snaps to cards, about 150px each', () => {
  const css = read('public/css/app.css');
  const rule = (sel) => {
    const m = css.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
    assert.ok(m, `${sel} has a rule`);
    return m[1];
  };
  const rail = rule('.wip-activity-rail');
  assert.match(rail, /display: flex;\s*gap: 10px;/);
  assert.match(rail, /margin-inline: calc\(-1 \* var\(--wip-gutter, 12px\)\);/, 'to both edges of the screen');
  assert.match(rail, /padding-inline: var\(--wip-gutter, 12px\);/, 'the first card on the page\'s gutter');
  assert.match(rail, /overflow-x: auto;/);
  assert.match(rail, /scroll-snap-type: x proximity;/);
  assert.match(rail, /scroll-padding-inline: var\(--wip-gutter, 12px\);/);
  assert.match(rail, /scrollbar-width: none;/);
  assert.match(css, /\n\.wip-activity-rail::-webkit-scrollbar \{ width: 0; height: 0; \}/);
  assert.match(rule('.wip-activity-rail > li'), /scroll-snap-align: start;/);
  const card = rule('.wip-activity-card');
  assert.match(card, /width: 150px;/, 'two and a bit on a 375px phone');
  assert.match(card, /min-height: 9\.75rem;/, 'one height, the placeholder\'s too');
  assert.match(card, /padding: 12px;/);
  // The card is the page's card: its ground, its hairline and its corners.
  assert.match(css, /\n\.wip-card \{\s*border-radius: var\(--wip-card-radius\);\s*background-color: var\(--wip-card-bg\);\s*box-shadow: inset 0 0 0 1px var\(--wip-card-line\), var\(--wip-card-shadow\);\s*\}/);
  assert.match(css, /--wip-radius-card: 16px;/);
  // It answers the pointer only where one hovers, and the keyboard always.
  assert.match(css, /@media \(hover: hover\) \{\s*\.wip-activity-card\[href\]:hover \{ box-shadow: inset 0 0 0 1px var\(--wip-card-line-hover, var\(--wip-card-line\)\)/, 'a placeholder (no href) does not answer');
  assert.match(css, /\n\.wip-activity-card:focus-visible \{ outline: 2px solid var\(--wip-ink-action\); outline-offset: 2px; \}/);
  // As many columns as the look has room for still drive Challenges' posters, which share the page's lines.
  for (const [at, n] of [['640px', 2], ['1024px', 4]]) {
    assert.match(css, new RegExp(`@media \\(min-width: ${at}\\) \\{ html:root \\{ --wip-cols: ${n}; \\} \\}`));
  }
  assert.match(css, /\.wip-poster \{\s*display: flex;\s*flex: 0 0 calc\(\(100% - \(var\(--wip-cols, 1\) - 1\) \* var\(--wip-card-gap\)\) \/ var\(--wip-cols, 1\)\);/, 'a challenge is one of the same columns');
});

test('a row answers the pointer, a press and the keyboard, and a placeholder row does not', () => {
  const css = read('public/css/app.css');
  // A soft ground of the ink, quiet because a row here is something to open, and a shade deeper pressed: tokens of the kit's first rule.
  assert.match(css, /--wip-item-hover: color-mix\(in srgb, var\(--wip-ink\) 5%, transparent\);\s*--wip-item-press: color-mix\(in srgb, var\(--wip-ink\) 9%, transparent\);/);
  // Only where a pointer hovers: a tap on a phone can leave a row :hover, and the ground would stay on it.
  assert.match(css, /@media \(hover: hover\) \{\s*html:root a\.wip-row:hover \{ background-color: var\(--wip-item-hover\); \}\s*html:root a\.wip-row:active \{ background-color: var\(--wip-item-press\); \}\s*\}/);
  // The whole row, in its own corners.
  assert.match(css, /\.wip-row \{[^}]*border-radius: var\(--wip-item-radius\);/);
  // A ring for the keyboard inside the row's edge, since the list clips what is outside it.
  assert.match(css, /\.wip-rows \{[^}]*overflow: hidden;/);
  assert.match(css, /html:root a\.wip-row:focus-visible \{ outline: 2px solid var\(--wip-ink-action\); outline-offset: -2px; \}/);
  // The fade is dropped with reduced motion, the device's or the setting's.
  assert.match(css, /html:root a\.wip-row \{ transition: background-color 120ms ease; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*html:root a\.wip-row \{ transition: none; \}\s*\}\s*html:root:where\(\[data-motion="reduce"\]\) a\.wip-row \{ transition: none; \}/);
  // The lines either side of a lit row give way: the row's own above it, and under it the line of the row a whole
  // line of columns on, so the chain is as long as the look's column count at each width.
  assert.match(css, /@media \(hover: hover\) \{\s*html:root \.wip-rows > li:has\(> a\.wip-row:is\(:hover, :focus-visible\)\) \{ box-shadow: none; \}\s*\}/);
  const widths = [['\\(max-width: 639\\.98px\\)', 1], ['\\(min-width: 640px\\) and \\(max-width: 1023\\.98px\\)', 2], ['\\(min-width: 1280px\\)', 4]];
  for (const [media, cols] of widths) {
    assert.match(css, new RegExp(`@media \\(hover: hover\\) and ${media} \\{\\s*html:root \\.wip-rows-cols > li:has\\(> a\\.wip-row:is\\(:hover, :focus-visible\\)\\)${' \\+ li'.repeat(cols)} \\{ box-shadow: none; \\}\\s*\\}`), `${cols} column(s): the row under a lit one is ${cols} on`);
  }
  // Those are the look's own counts: one, two from 640px, four from 1024px.
  assert.match(css, /html:root \{ --wip-cols: 1; \}\n@media \(min-width: 640px\) \{ html:root \{ --wip-cols: 2; \} \}\n@media \(min-width: 1024px\) \{ html:root \{ --wip-cols: 4; \} \}/);
  // Except on Home beside the open sidebar up to 1280px, where it stays two (four cut every title there), so
  // between 1024px and 1280px the line under a lit row is four on unless the sidebar is open, and two on if it is.
  const open = '#platform-tabs:not\\(\\.hidden\\):not\\(\\.platform-tabs-route-hidden\\):not\\(\\.platform-tabs-folded\\)';
  const lit = '\\.wip-rows-cols > li:has\\(> a\\.wip-row:is\\(:hover, :focus-visible\\)\\)';
  assert.match(css, new RegExp(`@media \\(min-width: 1024px\\) and \\(max-width: 1279\\.98px\\) \\{[^}]*\\}\\s*html:root body:has\\(> ${open}\\) #home-screen \\{ --wip-cols: 2; \\}`), 'Home is two across beside the open sidebar');
  assert.match(css, new RegExp(`@media \\(hover: hover\\) and \\(min-width: 1024px\\) and \\(max-width: 1279\\.98px\\) \\{\\s*html:root:not\\(:has\\(> body > ${open}\\)\\) ${lit}${' \\+ li'.repeat(4)} \\{ box-shadow: none; \\}\\s*html:root body:has\\(> ${open}\\) #home-screen ${lit}${' \\+ li'.repeat(2)} \\{ box-shadow: none; \\}\\s*\\}`), 'between 1024px and 1280px the line under a lit row follows the sidebar');
  // A placeholder is a row too, but a span, not a link: no rule lights a row that is not the link.
  assert.match(read('frontend/src/features/home/wip-kit.tsx'), /<span className="wip-row" aria-hidden="true">/);
  assert.doesNotMatch(css, /(?<!a)\.wip-row:(?:is\(|(?:hover|active|focus-visible)\s*[{,)])/, 'a placeholder would light up too');
  // The standard look and its brand drawing only: the brand look sets these rows flush with its card's inset and
  // answers the pointer with the title in its sky, the kit's rule it keeps.
  for (const m of css.matchAll(/^[^\n{}]*a\.wip-row[^\n{]*\{/gm)) {
    assert.ok(m[0].trim().startsWith('html:root'), `"${m[0].trim()}" reaches another look`);
  }
  assert.match(css, /\n\.wip-row:hover \.wip-item-title \{ color: var\(--wip-ink-action\); \}/);
});

test('a challenge is its picture, then its words beside it, in a row that pages with an arrow at each end', () => {
  const src = read('frontend/src/features/home/panels/challenges.tsx');
  assert.match(src, /className=\{`\$\{WIP_CARD\} wip-poster`\}[\s\S]{0,400}<WipChallengeArt[\s\S]{0,200}<span className="wip-item-text">/, 'the picture first, the words in their own column');
  // An arrow is drawn only while there is more that way, and names where it goes.
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-back" aria-label=\{t\('home:challenges\.scrollBack'\)\} onClick=\{\(\) => page\(-1\)\}/);
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-on" aria-label=\{t\('home:challenges\.scrollOn'\)\} onClick=\{\(\) => page\(1\)\}/);
  assert.equal(message('home:challenges.scrollBack'), 'Earlier challenges');
  assert.equal(message('home:challenges.scrollOn'), 'More challenges');
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-poster-art \{[^}]*width: var\(--wip-poster-art\);[^}]*height: var\(--wip-poster-art\);/);
  // A row keeps a project tile's own padding, so the two lists' icons start on the same lines.
  assert.match(css, /\.wip-row \{[^}]*padding: 0\.5rem var\(--wip-cell-pad\);/);
  // A poster is a card of its own (20 Nov 2026), so it has a card's padding,
  // and 4px more at its end, which keeps what it is worth clear of the arrow
  // drawn over that edge.
  assert.match(css, /\.wip-poster \{[^}]*padding: var\(--wip-card-pad\);\s*padding-inline-end: calc\(var\(--wip-card-pad\) \+ 0\.25rem\);/);
  // 24 Nov 2026: Recent activity is project cards, not rows, so the brand
  // look's padding for a recent thread's row (19 Nov 2026) went with them.
  assert.doesNotMatch(css, /#home-needs-card \.wip-row\b/);
});

test('each challenge is a card of its own, and the row around them draws none', () => {
  // 20 Nov 2026 (asked by the product owner): the posters were things in one
  // wide card; now each is the kit's card, and the row is no card at all.
  const row = (over) => ({
    eventId: 3, icon: null, illustration: null, illustrationTone: null, done: false,
    reward: '500 pts', state: 'new', stateLabel: 'Not started', fill: null, counted: false, earned: null, ...over,
  });
  const view = {
    key: 'challenges', title: 'Challenges', mode: 'next', heading: 'Next challenges', seeAll: true, note: null,
    rows: [
      row({ id: '11', goal: 'Use apps for 10 minutes', reward: '1,000 pts', state: 'progress', stateLabel: '1/10 Minutes this week', fill: 0.1, counted: true }),
      row({ id: '12', goal: 'Invite someone to Homeroom' }),
    ],
  };
  // The prerender's look is the standard one, which draws the kit's posters.
  const html = renderComponent('frontend/src/features/home/panels/challenges.tsx', 'ChallengesPanel', { view });
  assert.match(html, /<article class="home-panel" data-panel="challenges"[^>]*><div class="wip-posters-box" data-wip-challenges=""><div class="wip-posters">/,
    'the row is held by a box that is no card: no wip-card, no tone');
  const cards = [...html.matchAll(/<button type="button" class="([^"]*)" data-tone="([^"]*)" data-challenge-id="(\d+)"/g)];
  assert.deepEqual(cards.map((m) => [m[1], m[2], m[3]]), [['wip-card wip-poster', 'goal', '11'], ['wip-card wip-poster', 'goal', '12']],
    'each challenge is the kit\'s card, in the goal colours');
  assert.equal((html.match(/wip-card/g) || []).length, 2, 'the cards are the only cards');
  // Inside a card nothing changed: the picture, the goal, where the viewer
  // stands, what it is worth and the meter. Not an arrow of its own, nor
  // progress in a pill (an older design had both; asked to leave them out).
  for (const card of html.split('<button type="button" class="wip-card wip-poster"').slice(1)) {
    const body = card.slice(0, card.indexOf('</button>'));
    assert.match(body, /^[^>]*><span class="wip-poster-art" aria-hidden="true">[^<]*<\/span><span class="wip-item-text"><b class="wip-item-title">[^<]+<\/b><span class="wip-poster-facts"><span class="wip-item-meta">[^<]+<\/span><span class="wip-poster-worth">[^<]+<\/span><\/span><span class="wip-meter" aria-hidden="true"><span style="width:\d+%"><\/span><\/span><\/span>$/);
    assert.doesNotMatch(body, /<svg|wip-pill|wip-rail-arrow/);
  }

  const css = read('public/css/app.css');
  // The kit's card is the one recipe: its ground, its hairline, its corners.
  assert.match(css, /\n\.wip-card \{\s*border-radius: var\(--wip-card-radius\);\s*background-color: var\(--wip-card-bg\);\s*box-shadow: inset 0 0 0 1px var\(--wip-card-line\), var\(--wip-card-shadow\);\s*\}/);
  // The box paints nothing; it holds the row's margins, so an arrow's 50% is the cards' middle.
  assert.match(css, /\n\.wip-posters-box \{ position: relative; display: flow-root; \}/);
  assert.doesNotMatch(css, /\.wip-posters-card/, 'the old card round the row is gone');
  // A card gap between two cards, and room inside the scroller for what a
  // card draws outside its box (its shadow, its focus ring), given back by
  // the margins so the cards stay on the column's lines.
  assert.match(css, /\n\.wip-posters \{\s*display: flex;\s*gap: var\(--wip-card-gap\);\s*margin-block: -0\.25rem -1rem;\s*margin-inline: calc\(var\(--wip-card-gap\) \/ -2\);\s*padding-block: 0\.25rem 1rem;\s*padding-inline: calc\(var\(--wip-card-gap\) \/ 2\);\s*overflow-x: auto;\s*scroll-snap-type: x mandatory;\s*scroll-padding-inline: calc\(var\(--wip-card-gap\) \/ 2\);/);
  // Under the pointer the Workshop board's card edge and shadow; the keyboard's card also wears a focus ring.
  assert.match(css, /\n\.wip-poster:is\(:hover, :focus-visible\) \{ box-shadow: inset 0 0 0 1px var\(--wip-card-line-hover\), 0 8px 22px -14px var\(--wip-card-line-hover\); \}/);
  assert.match(css, /#dev-kanban \.dev-ws-wrow:hover \{ box-shadow: inset 0 0 0 1px var\(--wip-card-line-hover\), 0 8px 22px -14px var\(--wip-card-line-hover\); \}/, 'the board\'s own, which the poster copies');
  assert.match(css, /\n\.wip-poster:focus-visible \{ outline: 2px solid var\(--wip-ink-action\); outline-offset: 2px; \}/);
  // The arrows sit centred on the edge of the card at their end; a phone's 12px gutter keeps them a little further in.
  assert.match(css, /\n\.wip-rail-arrow-back \{ inset-inline-start: -1rem; \}\n\.wip-rail-arrow-on \{ inset-inline-end: -1rem; \}\n@media \(max-width: 639\.98px\) \{\n  \.wip-rail-arrow-back \{ inset-inline-start: -0\.625rem; \}\n  \.wip-rail-arrow-on \{ inset-inline-end: -0\.625rem; \}\n\}/);
  // While it loads, the placeholder holds the same shape: card-shaped blocks a card gap apart, nothing round them.
  const pending = 'html:root #home-challenges-section\\.home-section-pending > \\.home-panel-body';
  assert.match(css, new RegExp(`${pending} \\{ padding: 0; \\}`));
  assert.match(css, new RegExp(`${pending} > div \\{\\s*flex-direction: row;\\s*gap: var\\(--wip-card-gap\\);`));
  assert.match(css, new RegExp(`${pending} > div > div \\{\\s*flex: 0 0 calc\\(\\(100% - \\(var\\(--wip-cols\\) - 1\\) \\* var\\(--wip-card-gap\\)\\) \\/ var\\(--wip-cols\\)\\);\\s*height: calc\\(var\\(--wip-poster-art\\) \\+ 2 \\* var\\(--wip-card-pad\\)\\);\\s*border-radius: var\\(--wip-card-radius\\);\\s*background-color: var\\(--wip-skeleton\\);\\s*\\}`));
});

test('a title\'s plain words have their own span, and a project\'s name is one size', () => {
  const css = read('public/css/app.css');
  // The brand kit's second drawing (V2), whose tokens this test also held, was removed on 20 Nov 2026.
  assert.ok(!css.includes('[data-wip-tokens="brand2"]'));
  // The stroke is on a title's words alone: the kit gives plain words their own span.
  assert.match(read('frontend/src/features/home/wip-kit.tsx'), /typeof children === 'string' \? <span className="wip-head-words">\{children\}<\/span> : children/);
  // A plain pill in a card that asks reads the card's own ink (Advisory was pale on yellow in the dark).
  assert.match(css, /--wip-ink-soft: var\(--wip-ask-ink\);/);
  // One size at every width, outside any media query.
  assert.match(css, /\nhtml:root #app-list \.app-card-title \{\s*font-size: var\(--wip-title-size\);/, 'at the start of a line: not inside a media query');
  // On a phone alone it is a size down: four across leaves a name about 85px.
  assert.match(css, /@media \(max-width: 639\.98px\) \{[^@]*html:root #app-list \.app-card-title \{ font-size: var\(--wip-title-size-phone\);/);
});

test('A project\'s hub folds Invite and Make it public into its hero, and keeps Needs you in For you\'s row', () => {
  const card = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  // No Invite card and no Share it card: both actions are the hero's.
  assert.doesNotMatch(ws, /inviteCard=/);
  assert.doesNotMatch(card, /function ShareItCard\(|function InviteHeroCard\(/, 'no Share it card and no invite card under the hero');
  assert.match(card, /<WipHeroPublic slug=\{slug\} name=\{displayName\} data=\{data\} \/>/);
  assert.match(card, /function WipHeroPublic\([^)]*\): ReactNode \{\s*if \(data\.audience !== 'solo' \|\| !data\.can_manage \|\| data\.audience_change\) return null;\s*return <MakePublic /, 'Make it public is offered to exactly whom Share it offers it');
  // Invite is a full-size button in the action row, right after Open app, for
  // a member, and opens the same pane. The drawn arrow and the small pill on
  // the line about who is here are gone: the arrow was left pointing at
  // nothing once the pill wrapped (the visual audit's item 32).
  assert.match(card, /\{appButton\}\s*\{\/\*[\s\S]*?\*\/\}\s*\{member \? \(\s*<Button[\s\S]{0,160}data-ws-community-invite=""\s+title=\{t\('project:communityCard\.invite\.title'\)\}\s+onClick=\{openInviteLinks\}\s*>\s*<UserPlusIcon aria-hidden="true" \/>\s*\{t\('project:communityCard\.invite\.button'\)\}/);
  assert.equal(card.slice(card.indexOf('function HeroIdentity('), card.indexOf('export async function proposeAudience(')).includes('data-ws-community-invite'), false, 'nothing to invite with on the line about who is here');
  assert.doesNotMatch(card, /wip-hub-meta-invite|wip-hub-meta-arrow|SwooshArrowIcon/);
  assert.equal(card.split('data-ws-community-invite=""').length - 1, 1, 'one Invite on the page');
  // The hero's scenery is for show.
  assert.match(card, /<span className="wip-hero-wash" data-scene=\{platform \? 'home' : String\(communityScene\(slug\)\)\} aria-hidden="true" \/>\s*<span className="wip-hero-art" aria-hidden="true">/);
  // A project's preview beside the hero where there is one.
  assert.match(card, /const previewBeside = !platform && !!data\.cover\?\.illustration_url;/);
  // Pointing at that picture plays the project's loop over it, as a featured card on Home does.
  assert.match(card, /\{data\.cover\?\.preview_url \? <CardPreview src=\{data\.cover\.preview_url\} \/> : null\}/);
  // Needs you stays in the row with nothing waiting, shaped as its neighbours.
  assert.doesNotMatch(hub, /if \(alone && !claims/);
  assert.match(hub, /className="dev-ws-week-note wip-hub-door" data-ws-hub-needs-none=""/);
  const css = read('public/css/app.css');
  // As tall and as round as Open app, in the plain pills' outline.
  assert.match(css, /html:root #dev-workshop \.dev-ws-hero-summary \.dev-ws-hero-actions :is\(\[data-ws-community-invite\], \[data-ws-community-audience-change\]\) \{\s*display: inline-flex;[^}]*height: 2\.75rem;[^}]*font-size: 1rem;\s*font-weight: 700;/);
  assert.doesNotMatch(css, /\.wip-hub-meta-(?:invite|arrow|seat)\b/);
  assert.match(css, /html:root #dev-workshop \[data-ws-hub-topics\] \{ display: none; \}/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/, 'For you is three across from 768px');
});

test('A project\'s empty Needs you says so as good news, with the ways on under it', () => {
  // The run knows no look: the two pieces beside it read it (project-needs.tsx).
  const flow = read('frontend/src/features/review-flow/review-flow.tsx');
  const beside = read('frontend/src/features/review-flow/project-needs.tsx');
  assert.match(flow, /<ProjectNeedsEmpty slug=\{slug\} project=\{project\} anchorRef=\{anchorRef\}>\s*<p ref=\{anchorRef as never\}[^>]*data-needs-empty="" data-review-flow="">/, 'the plain line is every other look\'s');
  assert.match(flow, /<ProjectWaysIn slug=\{slug\} project=\{project\} \/>/, 'under what waits, too');
  assert.match(beside, /return !!slug && !!project;/);
  assert.match(beside, /if \(!drawn\) return children;\s*return \(\s*<div ref=\{anchorRef\} className="wip-needs" data-needs-empty="" data-review-flow="">/, 'the same hooks the plain line carries');
  assert.match(beside, /door\('1', 'workshop'[\s\S]{0,400}door\('3', 'discussion'[\s\S]{0,400}door\('2', 'status'/);
  assert.equal(message('communities:reel.caughtUp.title'), 'You\'re all caught up');
  assert.equal(message('communities:reel.caughtUp.next'), 'While you\'re here');
});

test('A board card\'s line says who and when first, then the item\'s number as a code', () => {
  const src = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.match(src, /<span className="dev-ws-wrow-sub">\{rowWords\(b, \{ whoFirst: true \}\)\}<\/span>/);
  assert.match(src, /if \(opts\.whoFirst\) \{\s*if \(b\.by && opts\.by !== false\) parts\.push\(b\.by\);\s*if \(b\.ago && opts\.ago !== false\) parts\.push\(b\.ago\);\s*parts\.push\(codeWords\(b\)\);/);
  assert.equal(message('project:workRow.code.request', { number: 6465 }), 'R#6465');
  assert.equal(message('project:workRow.code.change', { number: 5990 }), 'PR#5990');
});

test('The board ties a request to the changes made for it', () => {
  const { tiesOf } = loadTsx('frontend/src/features/dev-board/workshop/board-links.ts');
  const row = (noun, num, links) => ({
    getAttribute: (name) => ({ 'data-ws-noun': noun, 'data-ws-num': String(num), 'data-ws-for': links || null })[name] ?? null,
  });
  const request = row('request', 6464);
  const other = row('request', 6420);
  const change = row('change', 6460, '6464');
  const both = row('change', 6500, '6420,6464');
  const vote = row('vote', 2462);
  const rows = [request, other, change, both, vote];
  // From the request: each change made for it, request → change.
  assert.deepEqual(tiesOf(request, rows), [{ from: request, to: change }, { from: request, to: both }]);
  // From a change: the requests it is for that are on the board, still request → change.
  assert.deepEqual(tiesOf(both, rows), [{ from: request, to: both }, { from: other, to: both }]);
  assert.deepEqual(tiesOf(vote, rows), [], 'a vote is tied to nothing');
  // Nothing is written to the board: the drawing is a layer of its own on <body>.
  const src = read('frontend/src/features/dev-board/workshop/board-links.ts');
  assert.match(src, /document\.body\.appendChild\(svg\);/);
  assert.doesNotMatch(src, /classList|setAttribute\('class'|\.style\./, 'no class or style is written to a row');
  const row2 = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.match(row2, /\{\.\.\.\(board && b\.n \? \{\s*'data-ws-noun': b\.noun,\s*'data-ws-num': String\(b\.n\),/);
  // The door that opened the Workshop on the board was Standard (WIP)'s alone, and went with that look (24 Nov 2026, #7071). The board is by stage alone.
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.doesNotMatch(ws, /boardDoor|traversed\.current/, 'nothing moves the Workshop on to All items');
  assert.doesNotMatch(ws, /_setWorkshopGroup|GroupStrip/, 'in every look since request 6708: there is no switch to put on By stage');
  assert.match(ws, /useEffect\(\(\) => \(tab === 'all' \? watchBoardLinks\(\) : undefined\), \[tab\]\);/);
  // Advanced mode is on <html> for the look's one detail kept for it.
  assert.match(read('frontend/src/head.html'), /document\.documentElement\.setAttribute\('data-interface-mode', basic \? 'basic' : 'advanced'\);/);
  assert.match(read('public/css/app.css'), /html:root\[data-interface-mode="basic"\] #dev-kanban \[data-attr-field="category"\] \{ display: none; \}/);
});

test('The standard look: the Workshop opens on its overview, and the board is the page under it, with its way back (20 Nov 2026)', () => {
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  // The board draws its ties, and no door skips the overview.
  assert.match(ws, /useEffect\(\(\) => \(tab === 'all' \? watchBoardLinks\(\) : undefined\), \[tab\]\);/);
  assert.doesNotMatch(ws, /boardDoor/, 'and no look skips the overview any more (Standard (WIP), whose door did, was removed on 24 Nov 2026)');
  // The board shows its own head, "‹ All items": no rule hides it.
  const css = read('public/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const hiding = [...css.replace(/@media[^{]*\{/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /\.dev-ws-pagehead\b/.test(m[1]) && /display:\s*none/.test(m[2]))
    .flatMap((m) => m[1].split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => /\.dev-ws-pagehead\b/.test(s)));
  assert.deepEqual(hiding, [], 'nothing hides the board\'s way back');
  // "All items" is the page's one heading, so the place's name over it is the quiet one, as "Hub" is over the hub.
  assert.ok(css.includes('html:root #dev-workshop .dev-ws[data-ws-tab="all"] > .dev-ws-placebar .dev-ws-place-title { font-size: var(--wip-title-size); font-weight: 600; color: var(--wip-ink-muted); }'));
  // The Workshop tab's declared checks: the overview is the front page there (front-page.tsx, 24 Nov 2026).
  const front = JSON.parse(read('dapp.json')).tests.filter((check) => (check.expectSelector || '').includes('[data-ws-front'));
  assert.ok(front.length >= 4, 'the front page has declared checks');
  for (const check of front) assert.doesNotMatch(check.path, /[?&]skin=/, `"${check.name}" runs in the standard look`);
  assert.ok(!JSON.parse(read('dapp.json')).tests.some((check) => (check.expectSelector || '').includes('[data-ws-part="overview"]')), 'and nothing looks for the overview it replaced');
});

test('The menu is the token set\'s own panel, and a pinned project says who is in it', () => {
  const css = read('public/css/app.css');
  // The sidebar and the phone's bar are one panel, drawn from the menu's tokens at every width.
  assert.match(css, /html:root #platform-tabs \{[^}]*background: var\(--wip-nav-bg\);[^}]*font-family: var\(--wip-nav-font\);/);
  assert.match(css, /html:root \{[^}]*--wip-nav-bg: #3c7bd8;/, 'the menu wears the brand\'s own sky, under the standard look too');
  assert.match(css, /\[aria-current="page"\] \{\s*background: var\(--wip-nav-on-bg\);\s*box-shadow: none;\s*color: var\(--wip-nav-on-ink\);/);
  // The brand is the logotype at the panel's top, and the top bar starts beside the panel.
  assert.match(css, /html:root #platform-tabs::before \{[^}]*mask: var\(--wip-nav-brand-logo\) left center \/ contain no-repeat;/);
  assert.match(css, /#platform-header \{ padding-inline-start: calc\(var\(--wip-nav-w\) \+ 1rem\); \}/);
  // A folded sidebar opens from its arrow alone: pointing never starts a peek.
  assert.match(read('frontend/src/features/nav/rail-peek.ts'),
    /export function enterPeek\(\): void \{\s*clearPeekTimer\(\);(?:\s*\/\/[^\n]*)*\s*\}/);
  // A pinned project: members, then contributors, each on its line; no sentence; the same air on four sides.
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /t\('home:grid\.tile\.members', \{ count: app\.members, formatted: app\.members\.toLocaleString\(\) \}\)/);
  assert.equal(message('home:grid.tile.members_other', { formatted: '1,284', count: 1284 }), '1,284 members');
  assert.match(read('frontend/src/features/home/home.js'), /members: Math\.max\(0, Number\(app\.member_count\) \|\| 0\),/);
  assert.match(css, /html:root #app-list \.app-card-desc \{ display: none; \}/);
  assert.match(css, /html:root #app-list \{ padding: var\(--wip-cell-pad\); \}/);
  // A recent thread is its title, its project and when, in every look now: there is no kind line to hide.
  assert.doesNotMatch(css, /#home-needs-card \.wip-item-kind/);
});

test('The brand kit\'s token set draws the standard look; Standard (WIP) and every other set are gone', () => {
  const css = read('public/css/app.css');
  // The sets drawn and removed: eight on 19 Nov 2026, the brand kit's second drawing and Highlighter on 20 Nov 2026,
  // and on 24 Nov 2026 (#7071) the look that chose among them, "Homeroom brand kit (WIP)", with its own copy of the brand set.
  for (const gone of ['window', 'denim', 'afterdark', 'hands', 'shipped', 'frontpage', 'logosheet', 'greenhill', 'brand2', 'highlighter', 'brand']) {
    assert.ok(!css.includes(`[data-wip-tokens="${gone}"]`), `${gone} has no rule`);
    assert.ok(!read('frontend/locales/en/settings.json').includes(`"experimental.wipTokens.${gone}"`), `${gone} has no name`);
  }
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /data-wip-tokens|data-skin-wip/, 'no rule asks for the removed look or a token set');
  const head = read('frontend/src/head.html');
  assert.doesNotMatch(head, /WIP_TOKENS|setAttribute\('data-wip-tokens'|setAttribute\('data-skin-wip'|TOKEN_SETS|homeroom:wip-tokens'\)|getTokens|setTokens/,
    'the head writes nothing for it, and nothing is stored or pinned');
  // The standard look is drawn with the brand kit's values.
  assert.match(css, /html:root \{[^}]*--wip-font: 'Geist',/);
  // The sidebar's logotype is drawn in the menu's own ink, over nothing of the bar's glass.
  assert.match(css, /html:root #platform-tabs::before \{[^}]*background: var\(--wip-nav-ink-strong\);/);
});
