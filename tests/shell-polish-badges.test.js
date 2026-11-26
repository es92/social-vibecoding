'use strict';

// The 19 Oct 2026 polish board, batch C: the desktop shell, and one meaning
// per badge (#18). The other suites pin each piece where it lives; this one
// holds the parts that had no suite of their own:
//
//   - N21: the sidebar slides when the toggle shows or hides it.
//   - #18: the vocabulary itself. Grey is new to read, the accent is waiting
//     on you. (The list's fresh counts reach the sidebar through
//     community-scope.ts `takeCounts`, #5296, which has its own tests.)
//   - N14, N17, #20: the readable measure, the quiet dot, the centred bar.
//
// Run with: node --test tests/shell-polish-badges.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

/** One rule's body, by its exact selector line. */
function rule(selector, from = 0) {
  const at = CSS.indexOf(`${selector} {`, from);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('}', at) + 1);
}

// ── N21: the sidebar slides ────────────────────────────────────────────

test('the sidebar slides in and out on the compositor, and not at all for reduced motion', () => {
  const src = read('frontend/src/features/nav/rail-slide.ts');
  const { RAIL_SLIDE } = loadTsx('frontend/src/features/nav/rail-slide.ts');
  assert.deepEqual({ ...RAIL_SLIDE }, { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  assert.match(src, /\|\| reducedMotion\(\)/, 'the device or the Reduce motion setting (#6510)');
  assert.match(src, /!window\.matchMedia\?\.\('\(min-width: 768px\)'\)\.matches/, 'a phone has no fold');
  // One layout change, then transforms: the store change is committed
  // synchronously between the two measurements.
  assert.match(src, /flushSync\(commit\);/);
  assert.match(src, /screen\.root\.animate\(\[\{ transform: `translateX\(\$\{dx\}px\)` \}, \{ transform: 'none' \}\], RAIL_SLIDE\);/);
  // The rail folds to its strip and does not slide (26 Nov 2026: the looks
  // whose folded rail left the screen went): only the screen moves, and
  // `dirSign()` flips it, so in Arabic it plays the other way.
  assert.match(src, /\* dirSign\(\);/);
  const body = src.slice(src.indexOf('export function slideRail'));
  assert.equal((body.match(/\.animate\(/g) || []).length, 1, 'the screen alone');
  assert.doesNotMatch(body, /\{ (?!transform)[a-zA-Z]+: [`'"]/, 'every keyframe is a transform: nothing lays out again on a frame');
  assert.doesNotMatch(src, /platform-tabs-leaving/, 'nothing slides away, so nothing is drawn while it leaves');
});

// ── #18: grey is new to read; the accent is waiting on you ─────────────

test('an unread count is grey wherever it is, and said in words on a full row', () => {
  // The tab bar's grey, the one the rest match.
  assert.match(rule('\n.platform-tab-badge'), /background: var\(--text-faint, #8e8e93\);/);
  // Messages' rows: "2 new" in grey, no blue bubble, and the time in ink.
  // The shared row's trailing pair (ListRowMeta) draws them now.
  const row = read('frontend/@/components/ui/grouped-list.tsx');
  const meta = row.slice(row.indexOf('const rowMetaTop = cva('));
  assert.match(meta, /strong: 'font-semibold text-zinc-900 dark:text-zinc-100'/, 'an unread row\'s time in the ink');
  assert.match(meta, /<span className="ui-lrow-mb [^"]*text-zinc-500[^"]*">\{bottom\}<\/span>/, 'its count in grey');
  assert.doesNotMatch(meta.slice(0, meta.indexOf('\n}\n')), /violet|accent/, 'never the accent');
  const inbox = read('frontend/src/features/messages/index.tsx');
  assert.match(inbox, /tone=\{unread \? 'strong' : 'quiet'\}/);
  assert.match(inbox, /bottom=\{unread \? t\('messages:inbox\.newCount', \{ count: conversation\.unreadCount \}\) : null\}/,
    'a conversation says it in words');
  assert.equal(message('messages:inbox.newCount', { count: 2 }), '2 new');
  // The sidebar's chats and a project's channels (the Discussion is
  // #general's): grey; Needs you keeps the accent.
  assert.match(CSS, /\.platform-rail-nest :is\(\.platform-rail-sub-count, :is\(\[data-place="posts"\], \[data-place="discussion"\], \[data-place\^="c:"\]\) > \.dev-ws-place-count\) \{\s*background: var\(--text-faint, #8e8e93\);/);
  assert.match(CSS, /\.dev-ws-place:is\(\[data-place="posts"\], \[data-place="discussion"\], \[data-place\^="c:"\]\) \.dev-ws-place-count \{\s*background: var\(--text-faint, #8e8e93\);/);
  assert.match(rule('\n.dev-ws-place-count'), /background: var\(--accent\);/, 'the votes owed stay blue');
  // Red is the bell's alone: the place bar's "something waits" dot is not.
  assert.match(rule('\n.dev-ws-places-dot'), /background: #fff;/, 'white on the community\'s colour');
  assert.doesNotMatch(rule('\n.dev-ws-places-dot'), /#ff5a4f/);
});

// ── N17, N14, #20 ──────────────────────────────────────────────────────

test('the "still open" dot is quiet grey, and stays where the close control finds it', () => {
  const dot = rule('\n.app-live-dot');
  assert.match(dot, /background: var\(--text-muted\);/);
  assert.doesNotMatch(dot, /#22c55e/, 'no green dot on every running app');
});

test('a message reads at most 72 characters a line on a desktop, a phone untouched', () => {
  const at = CSS.indexOf('/* A READABLE MEASURE (N14');
  assert.ok(at > 0);
  const block = CSS.slice(at, CSS.indexOf('\n}\n', at));
  assert.match(block, /@media \(min-width: 768px\) \{\s*\.messages-markdown\.gc-msg-content \{\s*max-width: 72ch;/);
});

test('the desktop bar is one centred row in every state but over a running app', () => {
  const at = CSS.indexOf('/* ONE ROW, CENTRED, ON EVERY DESKTOP SCREEN (#20');
  assert.ok(at > 0);
  const block = CSS.slice(at, CSS.indexOf('/* A FLAT TOP EDGE', at) > 0 ? CSS.indexOf('/* A FLAT TOP EDGE', at) : at + 4000);
  const notApp = 'body:not(:has(#app-view:not(.hidden)[data-app-surface="app"])) :is(#platform-header, #landing-header)';
  assert.ok(block.includes(`${notApp} {\n    padding-bottom: 0.75rem;`), '12 under the row');
  assert.ok(block.includes(`${notApp}.un-safe-top-extend {\n      padding-top: calc(0.75rem + var(--un-safe-inset-top, env(safe-area-inset-top, 0px))) !important;`), '12 over it, plus the inset');
  assert.ok(block.includes(`html.web-browser-chrome ${notApp}.un-safe-top-extend {\n      padding-top: 0.75rem !important;`), 'a browser tab keeps its zero inset');
  assert.match(block, /#header-title \{\s*display: flex;\s*align-items: center;\s*height: 1\.75rem;/,
    'the title is the row\'s 28px and centres its words, wordmark or text alike');
  // 12 + 28 + 12: the bar is the same 52px it was.
  assert.match(CSS, /--platform-header-h: 3\.25rem/);
});

test('a group\'s header leads with a member\'s face and says who is still invited (N14)', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const header = src.slice(src.indexOf('function ThreadHeader('), src.indexOf('/** The day a message was sent'));
  // The count is the members who joined; the title can name one still asked,
  // so the people asked are said beside it, and an invitee reads the invitation.
  assert.match(header, /: invited\s*\? t\('messages:header\.subtitle\.invited'\)/);
  assert.match(header, /const asked = active\.kind === 'group' && !invited \? active\.members\.filter\(\(m\) => m\.status === 'invited'\)\.length : 0;/);
  assert.match(header, /const subtitle = asked \? dotText\(\[said, t\('messages:header\.subtitle\.invitedCount', \{ count: asked \}\)\]\) : said;/);
  assert.equal(message('messages:header.subtitle.group', { count: 2 }), '2 members');
  assert.equal(message('messages:header.subtitle.invitedCount', { count: 1 }), '1 invited');
  assert.equal(message('messages:header.subtitle.invited'), 'Invitation pending');
  // Audit C02: the members' faces its row in the list draws (GroupFaces), not one of them.
  assert.match(header, /const groupFaces = active\.kind === 'group' && !invited;/);
  assert.match(header, /: groupFaces \? <GroupFaces conversation=\{active\} \/>/, 'not the initials of its name ("E+")');
  // A bot's thread line says its name, not @homeroom_bot.
  assert.match(src, /name: reply\.sender\.bot \? senderName\(reply\.sender, \{ bare: true \}\) : reply\.sender\.username,\s*bot: !!reply\.sender\.bot,/);
  assert.match(read('frontend/src/features/message-actions/thread-activity.tsx'), /\{reply\.bot \? reply\.name : `@\$\{reply\.name\}`\}/);
});

test('one number on the Communities row: the votes hide the grey count of unread channels', () => {
  // The sidebar's row drew "1 28" once: a rule there brought the grey count
  // back beside the All row's own votes pill, and the rule hiding it weighed
  // less. The row is the tab itself now, with the one votes badge at both
  // widths, so the one rule beside the badge's own decides it everywhere and
  // nothing brings the grey count back.
  const hide = '.platform-tab-mark:has(.platform-tab-votes) > #platform-tabs-badge-communities { display: none; }';
  assert.equal(CSS.split(hide).length - 1, 1, 'the one rule, once');
  assert.doesNotMatch(CSS, /#platform-tabs-badge-communities:not\(\.hidden\) \{\s*display: inline-flex;/, 'no rule shows it again beside the votes');
  assert.doesNotMatch(CSS, /platform-tab-all-votes/, 'the All row\'s own pill is gone');
  // From 768px the votes sit at the row's end, the size of a row's counts.
  const at = CSS.indexOf('@media (min-width: 768px) {\n  /* THE ONE NUMBER THE REST FOLLOWS.');
  const block = CSS.slice(at, CSS.indexOf('\n}\n', at));
  const row = block.match(/\n {2}\.platform-tab-badge,\n {2}\.platform-tab-votes \{[^}]*\}/);
  assert.ok(row, 'the sidebar places both counts');
  assert.match(row[0], /position: static;\s*order: 2;/);
  assert.doesNotMatch(block, /#platform-tab-workshop \.platform-tab-votes \{\s*display: none;/, 'and the sidebar does not hide the tab\'s votes');
});

test('V02: on the phone\'s bar the Communities tab\'s one number is its votes; unread channels are a dot', () => {
  // Voting on the only change waiting turned a blue 1 into a grey 2 (the
  // channels' count in the same seat), which read as the count growing.
  const at = CSS.indexOf('@media (max-width: 767px) {\n  #platform-tabs-badge-communities {');
  assert.ok(at > 0, 'a phone-only rule for the channels\' badge');
  const body = CSS.slice(at, CSS.indexOf('}', at) + 1);
  assert.match(body, /width: 9px;/);
  assert.match(body, /font-size: 0;/, 'no figure on the dot');
  assert.match(body, /color: transparent;/);
  // Its accessible name stays the words, with no number to lose.
  assert.equal(message('core:tabs.unreadChannels'), 'Channels with unread messages');
  // And the votes still take its seat while any are owed.
  assert.ok(CSS.includes('.platform-tab-mark:has(.platform-tab-votes) > #platform-tabs-badge-communities { display: none; }'));
});
