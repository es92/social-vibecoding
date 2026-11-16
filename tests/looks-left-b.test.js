// What the lanes and the fix pass left on Messages, a project's pages, a
// request's and a change's page, You, Challenges and Standings (looks v2,
// the leftovers of group B, 11 Nov 2026). Each test pins one item: what a
// look now draws, from which of the product's own parts, and that the
// standard look is where it was.
//
// Run with: node --test tests/looks-left-b.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const wear = JSON.parse(read('frontend/looks/looks.json')).wear.roots;
const wearers = (root) => [wear[root].to, ...(wear[root].also || []).map((w) => w.to)];
/** A hand block of app.css, from its heading to the next one named. */
const block = (from, to) => {
  const a = css.indexOf(from);
  const b = css.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `the block "${from}" is in app.css`);
  return css.slice(a, b);
};
const rules = (text) => text.split('\n').filter((line) => line.startsWith('html'));
const LOOK = 'html[data-skin]:where(:not([data-skin="brand"]))';

test('the ⋯ of a request and a change wears the look: the popover on a desktop, the action sheet on a phone', () => {
  const hand = block('/* WHAT THE LANES LEFT, GROUP B (11 Nov 2026)', '/* YOU\'S DIALOGS');
  assert.ok(hand.includes(`${LOOK} .dev-card-menu {`), 'the popover is dressed');
  assert.match(hand, /\.dev-card-menu \{[^}]*background: var\(--fr-solid, var\(--fr-ground\)\);[^}]*box-shadow: var\(--fr-sh\), inset 0 0 0 1px var\(--fr-line\);/, 'the kit sheet\'s ground, shadow and edge');
  assert.ok(hand.includes(`${LOOK} .dev-card-menu-item:hover:not(:disabled) { background: var(--fr-sunk); color: var(--fr-ink); }`), 'a row lights in the sunk tone, not the accent');
  assert.ok(hand.includes(`${LOOK} .dev-card-menu-item-danger:hover:not(:disabled) { background: var(--fr-bad-t); color: var(--fr-bad); }`));
  assert.match(hand, /\.un-action-card \{[^}]*background: var\(--fr-solid, var\(--fr-ground\)\);/, 'the phone\'s sheet has the look\'s ground');
  assert.ok(hand.includes(`${LOOK} .un-action-btn.un-has-icon { justify-content: flex-start; gap: 14px; text-align: start; }`), 'a row with a glyph reads from the start, as the kit\'s row');
  assert.ok(hand.includes(`${LOOK} .un-action-btn.un-action-cancel { justify-content: center; color: var(--fr-mut); font-weight: 650; text-align: center; }`));
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'kit tokens only');
  // The menu is still the product's: nothing in its code knows a look.
  const view = read('public/js/app-view.js');
  assert.match(view, /menu\.className = 'dev-card-menu';/);
  assert.match(view, /PlatformUI\.actionSheet\(\{\n\s+actions: items\.filter/);
});

test('App slots, Share your week and Your feedback are the product\'s dialogs in the kit\'s sheet', () => {
  const hand = block('/* YOU\'S DIALOGS', '/* YOU BEFORE ITS DATA');
  const ids = '#profile-app-slots-sheet, #profile-week-share-sheet, #profile-feedback-sheet';
  assert.match(hand, new RegExp(`\\.un-modal:has\\(> :is\\(${ids}\\)\\) \\{\\n\\s+--un-modal-radius: 24px; --un-modal-padding: 24px;\\n\\s+background: var\\(--fr-solid, var\\(--fr-ground\\)\\);`), 'the modal is the kit\'s sheet');
  assert.ok(wearers('title').includes(':is(#profile-app-slots-sheet,#profile-week-share-sheet,#profile-feedback-sheet) h2'), 'the title wears the look\'s');
  const btn = wear.btn.also.find((w) => w.to === ':is(#profile-week-share-send,#profile-week-share-copy)');
  assert.deepEqual(btn && btn.parts, { quiet: '#profile-week-share-copy' }, 'Share is the look\'s button, Copy its quiet one');
  assert.match(hand, /#profile-app-quota \{\n\s+margin-bottom: 0; padding: 14px 16px; border: 0; border-radius: 16px;\n\s+background: var\(--fr-surface\); box-shadow: inset 0 0 0 1px var\(--fr-line\);/, 'the allowance box is the kit\'s card');
  assert.match(hand, /#profile-week-share-sheet \.rounded-2xl \{[^}]*background: var\(--fr-sunk\);/, 'the preview is the sunk box');
  assert.match(hand, /#profile-feedback-list \{ border-radius: 20px; background: var\(--fr-surface\); box-shadow: inset 0 0 0 1px var\(--fr-line\); \}/);
  for (const line of rules(hand)) {
    assert.match(line, /^html\[data-skin\]/);
    assert.match(line, /#profile-(app-slots|week-share|feedback)-/, 'only these three dialogs');
    assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  }
  for (const file of ['app-slots-sheet.tsx', 'week-share-sheet.tsx', 'feedback-sheet.tsx']) {
    assert.doesNotMatch(read('frontend/src/features/profile', file), /isFrameSkin|useLiveSkin|components\/ui\/kit/, `${file} does not branch on the look`);
  }
});

test('You before its data is the kit\'s page at its own shape; the standard look keeps its outline', () => {
  const view = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(view, /if \(view\.kind === 'loading'\) return frame \? <YouLoading \/> : <ProfileSkeleton \/>;/);
  const html = renderComponent('frontend/src/features/profile/frame/you-frame.tsx', 'YouLoading', {}, { cache: false });
  assert.match(html, /^<div class="fr" data-you-frame="" data-you-loading="" role="status" aria-label="Loading your profile">/, 'one status, with the standard outline\'s words');
  assert.match(html, /<div class="fr-inner animate-pulse" aria-hidden="true">/);
  assert.equal((html.match(/class="fr-row"/g) || []).length, 6, 'a card of four rows and one of two');
  assert.ok(html.includes('<div class="fr-cols">'), 'two columns, as the page');
  const hand = block('/* YOU BEFORE ITS DATA', '/* STANDINGS, WHAT THE BOARD SAYS');
  assert.ok(hand.includes('html[data-skin] [data-you-loading] [data-sk] { display: block; border-radius: 6px; background: color-mix(in srgb, var(--fr-ink) 9%, transparent); }'));
});

test('Standings: the first read, a failed read and a board with no table are the kit\'s; a row\'s details too', () => {
  const hand = block('/* STANDINGS, WHAT THE BOARD SAYS', '/* THE BOARD IS THE STRIP');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-body > .bg-red-50 { padding: 12px 16px; border: 0; border-radius: 16px; background: var(--fr-bad-t); color: var(--fr-bad); font-size: 15px; font-weight: 500; }`), 'a failed read is the kit\'s bad note');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-body > p:not(#tc-lb-disclaimer) { padding: 64px 16px; color: var(--fr-mut); font-size: 15px; text-align: center; }`), 'private, empty and nobody left are the lone line');
  assert.match(hand, /#tc-lb-body \.animate-pulse > div > div \{ height: 10px; border-radius: 5px; background: var\(--fr-sunk\); \}/, 'the outline\'s blocks are the sunk tone');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-drill h3 { color: var(--fr-ink); font-size: 17px; font-weight: 650; line-height: 1.3; letter-spacing: -.01em; }`), 'the details\' name is the 17px heading');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-drill .font-mono { color: var(--fr-ink); font-family: inherit; font-variant-numeric: tabular-nums; font-weight: 600; }`), 'figures line up by digit in the look\'s own type');
  assert.ok(hand.includes('html[data-skin="paper"]:is([data-challenges-frame], [data-standings-frame]) #leaderboard-event-bar { padding-inline: 40px; }'), 'the picker starts where Paper\'s page does');
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  // The pane's states are still its own markup: one Body, no second drawing.
  const pane = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(pane, /if \(!view \|\| view\.state === 'loading'\) return <StandingsSkeleton \/>;/);
  assert.match(pane, /<div id="tc-lb-drill">/);
});

// ── Messages' list (what lane M left) ──────────────────────────────────
const LIST = 'frontend/src/features/messages/frame-list.tsx';
const inboxRow = (key, title, over) => ({
  key, lead: null, title, line: 'hello', time: null, timeTitle: null, fresh: null, active: false,
  href: `#messages/${key}`, onClick() {}, ...over,
});
const inbox = (over) => renderComponent(LIST, 'MessagesFrameList', {
  people: [inboxRow('4', 'evan', { time: '4d ago' })],
  query: '', onQuery() {}, onNew() {},
  state: { loading: false, error: null, onRetry() {}, offline: false, empty: false, onStart() {}, searched: null },
  ...over,
}, { cache: false });

// 16 Nov 2026: Agents left Messages, and with it the changes in flight the
// kit list drew under its second tab: their state pill, their unseen dot and
// the "2 working" beside the tab's name.
test('Messages: under a look the list is conversations alone, with no change row, dot or Agents tab', () => {
  const html = inbox({ unread: 3 });
  assert.match(html, /<nav class="fr-tabs"><button type="button" class="fr-tab fr-on" aria-pressed="true">People<span class="fr-n">3<\/span><\/button><\/nav>/,
    'People is the one tab, with the unread count the standard heading carries');
  assert.doesNotMatch(html, /Agents|working|data-inbox-unseen|data-session-unread/);
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.doesNotMatch(pane, /sessionUnreadIds|notificationsStore|asides\.agents/, 'nothing reads a change\'s news or work any more');
  assert.doesNotMatch(read(LIST), /unseen|status\?: \{/, 'a row has no state pill or dot to draw');
  assert.ok(!css.includes('[data-inbox-unseen]'), 'and the dot has no rule left');
});

test('Messages: under a look the pane keeps its place across a live re-sort and offers Oldest chats', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  // Group D: a kit row carries the list's own key (`data-inbox-row`, passed through by the kit's Row), so
  // one selector reads both lists; a row is no longer told apart by its address.
  assert.doesNotMatch(pane, /FRAME_ROW|getAttribute\('href'\) === saved\.key/);
  assert.match(pane, /const nodes = el\.querySelectorAll<HTMLElement>\('\[data-inbox-row\]'\);\n\s+for \(const node of Array\.from\(nodes\)\) \{\n\s+const key = node\.dataset\.inboxRow;/, 'one reader for both lists');
  assert.match(pane, /row = el\.querySelector\(keyedRow\(saved\.key\)\);/, 'and one correction');
  assert.match(read('frontend/src/features/messages/frame-list.tsx'), /<Row\n\s+\/\/ [^\n]+\n\s+data-inbox-row=\{row\.key\}/);
  assert.match(pane, /const listShape = deferredQuery;/, 'a search is the reader moving the list: the held place is dropped');
  const branch = pane.slice(pane.indexOf('  if (frame) {\n    const me = Number'), pane.indexOf("aria-label={t('messages:inbox.listName')}"));
  assert.match(branch, /ref=\{scrollRef as RefObject<HTMLElement \| null>\}\n\s+onScroll=\{readAnchor\}/, 'the pane is the scroller under a look');
  assert.match(branch, /<InboxToEnd scroller=\{scrollRef\} \/>\n\s+<\/section>/, 'Oldest chats is the product\'s own button');
  assert.equal((pane.match(/<InboxToEnd scroller=\{scrollRef\} \/>/g) || []).length, 2, 'once in each list');
  const hand = block('/* MESSAGES\' LIST, WHAT LANE M LEFT', '/* NEW MESSAGE\'S DIALOG');
  assert.ok(hand.includes('html[data-skin] .messages-list-pane[data-frame-list] { overflow-anchor: none; }'), 'the browser\'s own anchoring is off, as on the standard scroller');
  assert.ok(hand.includes('html[data-skin] .messages-list-pane[data-frame-list] > [data-inbox-to-end] { position: sticky; bottom: 0; height: 0; }'), 'the button stays at the pane\'s foot');
  assert.match(hand, /\[data-inbox-to-end\] > div \{ bottom: calc\(var\(--fr-shell-bottom, 0px\) \+ 12px\) !important; \}/, 'over the look\'s own tab bar on a phone');
});

// ── All items (what lane P left) ───────────────────────────────────────
test('All items: a category\'s figures read on one line, its counts are the kit\'s pills, and By stage keeps its chips as the kit\'s', () => {
  const hand = block('/* What lane P left of a category\'s card', '/* WHO DECIDES (project-frame.tsx');
  const AT = 'html[data-skin] .dev-ws > [data-project-frame="all-items"] ~ .dev-ws-tabbody';
  assert.ok(hand.includes(`${AT} .dev-ws-stat { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }`), 'the figure, then its word (the mockup\'s "7 people | 7 items")');
  assert.ok(hand.includes(`${AT} .dev-ws-theme-people b { display: inline; }`));
  assert.ok(hand.includes(`${AT} .dev-ws-cnt > .dev-ws-dot { display: none; }`), 'a pill says its tone itself');
  assert.ok(hand.includes(`${AT} .dev-ws-cnt-review { background: var(--fr-wait-t); color: var(--fr-wait); }`));
  assert.ok(hand.includes(`${AT} .dev-ws-cnt-shipped { background: var(--fr-ok-t); color: var(--fr-ok); }`));
  assert.match(hand, /\[data-all-group="stage"\] ~ \.dev-ws-tabbody \.dev-ws-allbar :is\(#dev-kanban-filters-btn, \[data-quick-filter\]\) \{\n\s+height: 32px; padding: 0 14px; border: 0; border-radius: 999px;\n\s+background: var\(--fr-sunk\); color: var\(--fr-ink\);/, 'the chips over the board are the kit\'s small quiet buttons');
  assert.match(hand, /:is\(#dev-kanban-filters-btn, \[data-quick-filter\]\)\[aria-pressed="true"\] \{ background: var\(--fr-lit\);/, 'the pressed one is lit');
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  // By stage has no side column because today's page has none: the three chips are all it has over the board.
  const frame = read('frontend/src/features/dev-board/workshop/frame/project-frame.tsx');
  assert.match(frame, /data-all-group=/);
  // "re-drafting categories…" is said in the label over the categories, which wears the kit's label.
  assert.ok(wearers('cap').some((to) => to.includes('.dev-ws-sort > .dev-ws-eyebrow')), 'the eyebrow that says it wears the kit\'s label');
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /v\.meta\.source === 'ai' \? t\('project:allItems\.grouping\.redrafting'\) : t\('project:allItems\.grouping\.drafting'\)/);
});

// ── A request's and a change's page on a phone (v3, s32 to s35) ────────
test('a request and a change: what scrolls fades out under the pinned head, and on a phone Jump to latest stands clear of the labels', () => {
  const hand = block('/* A REQUEST\'S AND A CHANGE\'S PAGE UNDER ITS HEAD', '/* THE BOARD IS THE STRIP');
  assert.ok(hand.includes('html[data-skin] #dev-topic-thread .dev-request #gc-thread-scroll { -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 16px); mask-image: linear-gradient(to bottom, transparent 0, black 16px); }'), 'the head is over the page at every width');
  assert.match(hand, /@media \(max-width: 767\.98px\) \{\n\s+html\[data-skin\] #dev-topic-thread \.dev-request :has\(> \[data-jump-latest\]\) \{ justify-content: flex-end; padding-inline: 16px; \}/, 'the disc at the row\'s end, on a phone');
  assert.ok(hand.includes(`${LOOK} :is(#dev-topic-thread, .messages-screen) [data-jump-latest] { background: var(--fr-solid, var(--fr-surface)); color: var(--fr-ink);`), 'and it is the kit\'s round button');
  assert.ok(hand.includes('html[data-skin="paper"] .dev-change-pair .dev-change-gate-act .gc-vote-btn { background: var(--fr-ctl); }'));
  // The standard page opens at the end of the discussion too: where the page opens is not the look's to change.
  assert.doesNotMatch(read('frontend/src/features/dev-board/topic/frame/topic-frame.tsx'), /scrollTop|scrollTo\(/);
});

// ── A project's pages ───────────────────────────────────────────────────
test('a place\'s own body starts where its look\'s page does', () => {
  assert.match(css, /@media \(min-width: 768px\) \{\n\s+html\[data-skin="paper"\] \.dev-ws > \[data-project-frame\] ~ \.dev-ws-tabbody \{ padding-inline: 40px; \}\n\}/);
  const kit = (look) => read('frontend/looks', `${look}.css`);
  assert.match(kit('paper'), /\.inner\{padding:36px 40px 48px\}/, 'Paper\'s page is 40px in');
});

// ── Challenges and Standings ────────────────────────────────────────────
test('Challenges and Standings say "You, Challenges" to the bar, and go back the way the shell\'s arrow goes', () => {
  const frame = read('frontend/src/features/leaderboard/frame/challenges-frame.tsx');
  assert.match(frame, /const shellBack = \(\) => \{ document\.getElementById\('back-btn'\)\?\.click\(\); \};/);
  assert.match(frame, /const crumb = \[you, here\];\n\s+\/\/ [^\n]+\n\s+framePageStore\.set\(\{ crumb, onBack: shellBack, phoneUp: true \}\);\n\s+return \(\) => \{ if \(framePageStore\.get\(\)\.crumb === crumb\) framePageStore\.set\(\{ crumb: null, onBack: null \}\); \};/, 'a pane going down takes back only its own crumb: the two tabs are two panes');
  assert.equal((frame.match(/useChallengesCrumb\(up\);/g) || []).length, 2, 'both tabs, while each is the one on show');
  assert.match(frame, /const you = tc\('core:tabs\.me'\);\n\s+const here = t\('leaderboard:tabs\.challenges'\);/, 'words the product already has');
});

// ── Make's sheets, You's tabs ───────────────────────────────────────────
test('Make\'s two sheets are the kit\'s sheet where they stand; You\'s six tabs fade out at the row\'s end on a phone', () => {
  const hand = block('/* MAKE\'S TWO SHEETS', '/* MAKE AND IMPORT IN THE KIT');
  const S = `${LOOK} :is([data-make-rule-sheet], [data-make-more-sheet]) > [role="dialog"]`;
  assert.match(hand, /> \[role="dialog"\] \{\n\s+padding-inline: 24px; border-radius: 24px 24px 0 0;\n\s+background: var\(--fr-solid, var\(--fr-ground\)\); color: var\(--fr-ink\); font-family: var\(--fr-f\);/);
  assert.ok(hand.includes(`${S} [data-who-preset][aria-checked="true"] { box-shadow: inset 0 0 0 2px var(--fr-acc); }`), 'the picked preset has the accent\'s ring');
  assert.ok(hand.includes(`${S} [data-make-rule-done] { height: 44px; padding: 0 20px; background: var(--fr-acc); color: var(--fr-acc-ink); font: 650 15px/1 var(--fr-f); }`), 'Done is the kit\'s button');
  assert.ok(wearers('title').includes(':is([data-make-rule-sheet],[data-make-more-sheet]) > [role="dialog"] h2[id]'));
  assert.ok(wearers('cap').includes(':is([data-make-rule-sheet],[data-make-more-sheet]) > [role="dialog"] h2:not([id])'));
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  for (const file of ['frontend/src/features/first-session/more-sheet.tsx']) assert.doesNotMatch(read(file), /isFrameSkin|useLiveSkin/, 'the sheet does not branch on the look');
  assert.ok(css.includes('html[data-skin]:not([dir="rtl"]) [data-you-frame] .fr-tabs { -webkit-mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);'));
  assert.ok(css.includes('html[data-skin][dir="rtl"] [data-you-frame] .fr-tabs { -webkit-mask-image: linear-gradient(to left, black calc(100% - 28px), transparent);'));
});
