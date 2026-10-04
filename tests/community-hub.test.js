'use strict';

// A project's page is its community's HUB beside its WORKSHOP, and the
// channels live on the hubs rather than in Messages:
//
//   - the middle tab is Communities (frontend/src/features/nav/tab-bar.tsx),
//     with a count of the channels you have unread;
//   - a project's page has two tabs, the hub and the Workshop, with Needs you
//     and All items as pages under them (dev-board/workshop/workshop.tsx);
//   - the hub draws the channel's last messages, what needs you, and members
//     and activity (dev-board/workshop/hub-cards.tsx);
//   - Messages is people and agents, and an open channel lights Communities
//     and hangs off its hub (features/messages/);
//   - #general is the Homeroom community's channel: posting there needs that
//     community, and Homeroom's old project channel is read-only.
//
// The database half (the #general gate, the archive, the summaries) is pinned
// against a real schema in tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const TABS = read('frontend/src/features/nav/tab-bar.tsx');
const STORE = read('frontend/src/features/messages/store.ts');

const community = (over = {}) => ({
  slug: 'garden',
  name: 'Garden',
  member_count: 12,
  is_member: true,
  is_creator: false,
  audience: 'open',
  audience_label: 'Public community',
  members: [{ id: 1, username: 'ada' }, { id: 2, username: 'lin' }],
  channel: {
    last_message: 'See you Sunday',
    last_at: '2026-09-20T10:00:00Z',
    last_by: 'lin',
    unread_count: 2,
    recent: [
      { id: 1, content: 'Who has seeds?', created_at: '2026-09-19T10:00:00Z', by: 'ada' },
      { id: 2, content: 'See you Sunday', created_at: '2026-09-20T10:00:00Z', by: 'lin' },
    ],
    href: '#messages/app/garden',
    handle: null,
  },
  activity: { active_week: 4, shipped_month: 3 },
  approval: { policy: 'anyone', approvals_required: null, electorate: 12, required: 5 },
  ...over,
});

test('the bar reads Home, Discover, Messages, Communities, you — Messages in the middle', () => {
  const order = [...TABS.matchAll(/\{ key: '([a-z]+)' as const, label: '([A-Za-z]+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(order.map((o) => o[0]), ['discover', 'messages', 'workshop', 'me'],
    'after Home, whose entry is written across lines');
  assert.deepEqual(order.find((o) => o[0] === 'workshop'), ['workshop', 'Communities'],
    'the key stays `workshop`; the word is Communities');
  assert.match(TABS, /key: 'workshop' as const, label: 'Communities', href: '#communities', Icon: UserGroupIcon/);
  // The channels' count rides the Communities tab, the conversations' the
  // Messages tab, and the Messages store writes both.
  assert.match(TABS, /key === 'workshop' \? \(\s*<TabBadge count=\{communities\} id="platform-tabs-badge-communities"/);
  assert.match(STORE, /messages: state\.conversations\s*\.filter\(\(item\) => item\.kind !== 'channel' && item\.unreadCount > 0\)\.length,/);
  assert.match(STORE, /communities: state\.conversations\.filter\(\(item\) => item\.kind === 'channel' && item\.unreadCount > 0\)\.length\s*\+ state\.discussions\.filter\(\(item\) => item\.section !== 'more' && \(item\.unreadCount \|\| 0\) > 0\)\.length,/);
});

test('a project page is four tabs, Hub, Discussion, Needs you and Workshop, with All items the Workshop\'s page (#852)', () => {
  const { pageParent, pageTitle } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const band = loadTsx('frontend/src/features/dev-board/workshop/project-band.tsx');
  assert.deepEqual(band.PROJECT_TABS.map((t) => [t.key, t.label]),
    [['status', 'Hub'], ['discussion', 'Discussion'], ['needs', 'Needs you'], ['workshop', 'Workshop']]);
  assert.equal(band.litTab('all'), 'workshop', 'the Workshop tab stays lit over All items');
  assert.equal(pageParent('all'), 'workshop', 'All items goes back to the Workshop');
  assert.deepEqual(['needs', 'workshop', 'all', 'discussion'].map(pageTitle), ['Needs you', 'Workshop', 'All items', 'Discussion']);
  // The band on every page; All items adds its way back under it.
  assert.match(LANDER, /const pageBar = tab === 'all' \? \(/);
  assert.match(LANDER, /<PageBack\s+label="Workshop"\s+title=\{pageTitle\(tab\)\}\s+onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/);
  assert.match(LANDER, /\{band\}\s*\{pageBar\}/);
  // The hub's order, as agreed: the hero (who is here, what it is, what you
  // can do, the fortnight), what landed since your last visit, Needs you (a
  // quiet line when no vote is owed, #3408), the discussion's last two
  // messages (or Share it, for Just you), and your work. One column at every
  // width. Start a new change ended it until #852's review moved it into the
  // hero's ⋯ (tests/improve-action-deduplication.test.js).
  const hub = LANDER.slice(LANDER.indexOf("{tab === 'status' ? ("), LANDER.indexOf("{tab === 'discussion' ? ("));
  const order = ['<CommunityCard', '<SinceSummaryCard', '<NeedsCard', '<ChannelCard', '<ShareItCard', '<YourWorkCard'].map((x) => hub.indexOf(x));
  assert.ok(order.every((n) => n >= 0), `all six on the hub: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'hero, summary, Needs you, discussion, Share it, your work');
  assert.doesNotMatch(hub, /data-ws-start-change/, 'no Start a new change at its foot');
  assert.match(hub, /\{owesVote\(v\.queue\)\s*\? <NeedsCard [^\n]*\n\s*: <NothingToVote queue=\{v\.queue\} onOpen=\{\(\) => openTab\('needs'\)\} \/>\}/,
    'Needs you only while a vote is owed; one quiet line in its place otherwise (#3408)');
  assert.match(hub, /<SinceSummaryCard slug=\{slug\} since=\{v\.since \? v\.since\.baseline : 0\} onMore=\{\(\) => openTab\('workshop'\)\} \/>/,
    'the summary card\'s Week by week is the Workshop tab');
  assert.match(hub, /<ChannelCard slug=\{slug\} name=\{app\.name \|\| slug\} data=\{community\} compact onOpen=\{\(\) => openTab\('discussion'\)\} \/>/,
    'the discussion is a preview whose Open is the Discussion tab');
  assert.match(hub, /\{v\.mine && \(v\.mine\.rows\.length \|\| v\.mine\.viewer\) \? \(\s*<YourWorkCard/,
    'your work for any signed-in viewer, with work or without (#3489)');
  assert.doesNotMatch(hub, /<WorkshopDoor|dev-ws-hub-side|data-ws-since=""/, 'no Workshop door, no second column, and the since list is the Workshop\'s');
  assert.doesNotMatch(read('public/css/app.css'), /dev-ws-hub-side/);
  // Discussion is the channel whole.
  assert.match(LANDER, /\{tab === 'discussion' \? \(\s*<ProjectDiscussion slug=\{slug\}/);
  // The Workshop tab: the approval rules, your work (its first three, #852
  // review), All items with See all, then the since list by week.
  const ws = LANDER.slice(LANDER.indexOf("{tab === 'workshop' ? ("), LANDER.indexOf("{tab === 'needs' ? ("));
  const w = (x) => ws.indexOf(x);
  assert.ok(w('data-ws-mine=""') < w('data-ws-dashboard=""') && w('data-ws-dashboard=""') < w('data-ws-since=""'),
    'your work, All items, then what changed');
  assert.match(ws, /v\.mine\.rows\.slice\(0, mineAll \? undefined : WORKSHOP_WORK_FIRST\)/, 'your work shows its first rows');
  assert.equal(loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx').WORKSHOP_WORK_FIRST, 3);
  assert.match(ws, /data-ws-mine-more=""[\s\S]{0,160}onClick=\{\(\) => setMineAll\(!mineAll\)\}/, 'and the rest behind Show N more');
  assert.match(ws, /<span className="dev-ws-head-title">All items<\/span>\s*<button[\s\S]*?data-ws-all-open=""\s*onClick=\{\(\) => openTab\('all'\)\}/);
  // The approval rules are the Workshop page's head (#3528): the page's foot
  // for a round (#3487), and not the head of All items, where they sat before.
  assert.ok(w('<ApprovalRules') >= 0 && w('<ApprovalRules') < w('<WorkshopNotices') && w('<ApprovalRules') < w('data-ws-mine=""'),
    'the approval rules open the Workshop page');
  assert.match(ws, /<>\s*\{\/\*[\s\S]*?\*\/\}\s*\{slug \? <ApprovalRules slug=\{slug\} \/> : null\}/, 'as its first section');
  assert.equal(ws.split('<ApprovalRules').length - 1, 1, 'and only there');
  const all = LANDER.slice(LANDER.indexOf("{tab === 'all' ? ("));
  assert.ok(!all.slice(0, all.indexOf('data-ws-pane=""')).includes('<ApprovalRules'), 'and All items no longer leads with them');
  // `?ws=discussion` is a deep link like the others.
  assert.match(read('public/js/app-view.js'), /WORKSHOP_TABS: \['status', 'discussion', 'workshop', 'needs', 'all'\],/);
});

test('the hub\'s channel card shows the last messages, what is new, and the way in', () => {
  const { ChannelCard } = loadTsx(HUB);
  const html = renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: community() }));
  assert.match(html, /data-ws-channel=""/);
  assert.match(html, /data-ws-channel-unread="2"[^>]*>2 new</);
  assert.match(html, /<a href="#messages\/app\/garden" class="dev-ws-hub-open un-touch-target" data-ws-channel-open="">Open/);
  const lines = [...html.matchAll(/class="dev-ws-hub-msg-text">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(lines, ['Who has seeds?', 'See you Sunday'], 'oldest first, as a transcript reads');
  // The composer posts from here, to the room's own write route.
  assert.doesNotMatch(html, /data-ws-channel-compose/, 'no write route, no composer');
  const withPost = renderToHtml(createElement(ChannelCard, {
    slug: 'garden', name: 'Garden',
    data: community({ channel: { ...community().channel, post_url: '/api/apps/garden/messages' } }),
  }));
  assert.match(withPost, /<form class="dev-ws-hub-compose" data-ws-channel-compose=""><input type="text" class="dev-ws-hub-compose-input" data-ws-channel-input="" aria-label="Message Garden" placeholder="Message Garden…"/);
  assert.match(withPost, /<button type="submit" class="dev-ws-hub-compose-send" data-ws-channel-send="" aria-label="Send" disabled="">/,
    'nothing to send yet');
  assert.doesNotMatch(html, /data-ws-channel-archive/, 'no archive on an ordinary project');
  // Homeroom's: #general, and no link to its old discussion (#3406).
  const homeroom = renderToHtml(createElement(ChannelCard, {
    slug: 'homeroom',
    name: 'Homeroom',
    data: community({
      channel: { ...community().channel, href: '#messages/1', handle: 'general', archive_href: '#messages/app/homeroom' },
    }),
  }));
  assert.match(homeroom, /data-ws-channel-handle="general"/);
  assert.match(homeroom, /<span class="dev-ws-hub-handle">#general<\/span>/);
  assert.match(homeroom, /<a href="#messages\/1" class="dev-ws-hub-open/);
  assert.doesNotMatch(homeroom, /data-ws-channel-archive|dev-ws-hub-archive|Earlier project discussion/,
    'the channel card links to no archive');
  // THE HUB'S PREVIEW (#852): the card's own look, its last two messages,
  // no composer, and how many more are unread above them, opening the
  // Discussion tab rather than the room.
  const five = [1, 2, 3, 4, 5].map((n) => ({ id: n, content: `m${n}`, created_at: '2026-09-20T10:00:00Z', by: 'ada' }));
  const preview = renderToHtml(createElement(ChannelCard, {
    slug: 'garden', name: 'Garden', compact: true, onOpen: () => {},
    data: community({ channel: { ...community().channel, recent: five, unread_count: 7, post_url: '/api/apps/garden/messages' } }),
  }));
  assert.match(preview, /data-ws-channel="preview"/);
  assert.match(preview, /<span class="dev-ws-head-title">Discussion<\/span>/);
  assert.deepEqual([...preview.matchAll(/class="dev-ws-hub-msg-text">([^<]*)</g)].map((m) => m[1]), ['m4', 'm5'], 'the last two');
  assert.match(preview, /<button type="button" class="dev-ws-hub-more-unread un-touch-target" data-ws-channel-more-unread="5">5 more unread messages<\/button>/,
    'seven unread, two of them shown');
  assert.ok(preview.indexOf('data-ws-channel-more-unread') < preview.indexOf('data-ws-channel-recent'), 'above the messages');
  assert.match(preview, /<button type="button" class="dev-ws-hub-open un-touch-target" data-ws-channel-open="">Open/, 'Open is the tab');
  assert.doesNotMatch(preview, /data-ws-channel-compose|data-ws-channel-unread/, 'no composer, and the count is the line, not a pill');
  const { moreUnread } = loadTsx(HUB);
  assert.equal(moreUnread(2, 2), 0, 'nothing more to say when both unread are on screen');
  assert.equal(moreUnread(0, 2), 0);
  // Nothing to draw without a record, or for a viewer who may not talk here.
  assert.equal(renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: null })), '');
  assert.equal(renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: community({ channel: null }) })), '');
});

test('Needs you opens the queue and counts the votes owed', () => {
  const { NeedsCard } = loadTsx(HUB);
  const row = (key, title, who) => ({ t: 'card', key, card: { title: { text: title } }, who, kind: 'vote' });
  const needs = renderToHtml(createElement(NeedsCard, {
    queue: [row('a', 'Dark mode', 'ada'), row('b', 'Tags', 'lin'), row('c', 'Export', 'kai')],
    canPost: true,
    onOpen: () => {},
  }));
  assert.match(needs, /<span class="dev-ws-head-title">Needs you<\/span><span class="dev-ws-head-n">3 to vote<\/span>/);
  assert.match(needs, /<span class="dev-ws-hub-needs-title">Dark mode<\/span><span class="dev-ws-hub-needs-sub">from @ada · and 2 more<\/span>/);
  assert.doesNotMatch(needs, /Join to vote/);
  const outsider = renderToHtml(createElement(NeedsCard, { queue: [row('a', 'Dark mode', 'ada')], canPost: false, onOpen: () => {} }));
  assert.match(outsider, /Join to vote on these\./);
  assert.doesNotMatch(needs, /data-ws-hub-needs-none/, 'the door says nothing about an empty queue: it is not drawn then');
  // #3408: no vote owed, no card. One quiet line says so.
  const { NothingToVote, owesVote } = loadTsx(HUB);
  assert.equal(owesVote([]), false);
  const none = renderToHtml(createElement(NothingToVote, { queue: [], onOpen: () => {} }));
  assert.equal(none, '<p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on.</p>');

  // Members & activity is the hero's since #3268: pinned in
  // tests/community-hub-details.test.js.
  assert.equal(loadTsx(HUB).MembersCard, undefined, 'no separate Members & activity card');
});

test('an open channel lights Communities and hangs off its hub; Messages lists people and agents', () => {
  assert.match(STORE, /export function channelHub\(\): string \| null \{\s*if \(state\.route\.appSlug\) return `#app\/\$\{encodeURIComponent\(state\.route\.appSlug\)\}\/workshop`;/);
  assert.match(STORE, /if \(!row \|\| row\.kind !== 'channel'\) return null;/, '#general is the channel among the conversations');
  assert.match(STORE, /navStore\.set\(\{ tab: hub \? 'workshop' : 'messages' \}\);/);
  assert.match(STORE, /app\.setBackIcon\?\.\('arrow', hub\);/);
  assert.match(STORE, /if \(!state\.route\.threadRootId && channelHub\(\)\) return false;/,
    'Back on a phone follows the arrow to the hub rather than to the list');
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const channelOpen = !!snap\.route\.appSlug\s*\|\| \(!!snap\.route\.conversationId && snap\.active\?\.id === snap\.route\.conversationId && snap\.active\?\.kind === 'channel'\);/);
  const inbox = read('frontend/src/features/messages/inbox.ts');
  assert.match(inbox, /if \(item\.kind === 'channel'\) continue;/);
  assert.match(inbox, /chats\.sort\(byClock\);/);
  // B5: the Homeroom bot's DM first, the rest in the order things happened.
  assert.match(inbox, /if \(at > 0\) chats\.unshift\(\.\.\.chats\.splice\(at, 1\)\);\n\s+return chats;/);
});

test('#general needs the Homeroom community to post in; Homeroom\'s old channel takes no post', () => {
  const route = read('src/routes/conversations.js');
  const send = route.slice(route.indexOf("router.post('/api/conversations/:id/messages'"));
  assert.match(send.slice(0, send.indexOf('conversations.sendMessage(')),
    /const join = await communities\.generalNeedsJoin\(pool, id, req\.user, config\?\.selfAppSlug\);\s*if \(join\) return res\.status\(403\)\.json\(join\);/,
    'refused before the message is written, with the join_required body the client turns into Join');
  const ws = read('src/services/ws.js');
  assert.match(ws, /if \(msg\.type === 'chat' && \(!msg\.thread \|\| msg\.thread\.type === 'message'\)\) \{[\s\S]*?communities\.channelArchived\(pool, client\.appId\)[\s\S]*?return \{ ok: false, code: 'channel_moved' \};/,
    'the main stream and its reply threads; a proposal\'s or a request\'s own thread stays open');
  assert.match(read('src/routes/chat.js'), /if \(result\?\.code === 'channel_moved'\) \{\s*return res\.status\(409\)\.json\(\{ error: communities\.CHANNEL_MOVED, code: 'channel_moved' \}\);/);
  const view = read('public/js/app-view.js');
  assert.match(view, /const archived = \(ctx && ctx\.slug\)\s*\? !!ctx\.archived\s*: !!\(AppView\.appData && AppView\.appData\.self_hosted\);/);
  assert.match(STORE, /archived: app\.self_hosted === true,\s*readOnly: app\.can_collaborate === false \|\| app\.self_hosted === true,/);
  const route2 = read('src/routes/apps.js');
  assert.match(route2, /if \(app\.slug === config\.selfAppSlug\) \{\s*const general = await communities\.generalChannelSummary\(pool, req\.user\?\.id\);/);
  assert.doesNotMatch(route2, /archive_href/, 'the hub names no archive (#3406)');
});

test('#852 review: a project\'s own Discussion is a fitted pane, and Homeroom\'s is #general in place (#3494)', () => {
  // #general is a conversation of Messages rather than an app chat. #3491
  // made the tab a door to it on the Messages screen, which swapped the
  // page's header and tabs; #3494 mounts it in the page instead, like any
  // project's own channel (tests/homeroom-discussion-in-place.test.js).
  const PD = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  assert.doesNotMatch(LANDER, /discussionElsewhere|openDiscussionElsewhere/, 'the tab turns the page for Homeroom too');
  assert.match(PD, /<EmbeddedConversation conversationId=\{room\} active=\{onShow\} at=\{roomAt\} \/>/);
  assert.doesNotMatch(PD, /location\.replace/);
  // A project's own channel fills the reading area like Needs you: no guessed
  // height, the chain may shrink it, and the composer's tab-bar reserve is not
  // taken twice.
  const CSS = read('public/css/app.css');
  assert.doesNotMatch(CSS, /\.dev-ws-discussion \{[^}]*calc\(100dvh - 210px\)/);
  assert.match(CSS, /#dev-workshop > \.dev-ws\[data-ws-tab="discussion"\] \{ min-height: 0; \}/);
  assert.match(CSS, /html\[data-browser-scroller\] \.dev-ws\[data-ws-tab="discussion"\] \{\s*height: var\(--ws-fit\);/);
  assert.match(CSS, /\.dev-ws-discussion \.platform-safe-bar \{ padding-bottom: 0\.5rem !important; \}/);
});

test('#3499: the band and the Discussion pane bleed to the screen\'s edges, not past them', () => {
  // Holding the Workshop, #dev-body narrows its sides from `px-3`'s 12px to
  // 4px. The band and the Discussion pane bled 12 against it and ran 8px
  // past both edges of a phone, and where #dev-forum-scroll is the scroller
  // (an installed app, the native WebView) the hub scrolled sideways by 8px.
  // Each bleed has to cancel exactly the padding it sits in.
  const CSS = read('public/css/app.css');
  const body = CSS.match(/^#dev-body:has\(> #dev-workshop\) \{ padding: \S+ (\d+)px /m);
  assert.ok(body, '#dev-body has its Workshop padding');
  const side = Number(body[1]);
  const band = CSS.match(/^\.dev-ws-tabs\.dev-ws-band \{\s*margin: -18px -(\d+)px 0;/m);
  assert.ok(band, 'the band bleeds under the header and to the sides');
  assert.equal(Number(band[1]), side, 'the band cancels #dev-body\'s side padding, no more');
  const pane = CSS.match(/^@media \(max-width: 767\.98px\) \{\s*\.dev-ws-discussion \{ margin: 0 -(\d+)px; \}/m);
  assert.ok(pane, 'the Discussion pane bleeds on a phone');
  assert.equal(Number(pane[1]), side, 'and so does the Discussion pane, to the band\'s width');
});

test('#3522: on a phone the band pins where it rests', () => {
  // Renamed in place (pull-to-refresh under the tabs, evan, 2026-10-01): this
  // test also pinned #3514's half, "and a pull stretches it from the header",
  // the community-coloured gap under the header and the hook that sized it.
  // A pull no longer moves the band, so that gap never opens; the test below
  // pins what a pull does now, and that the old paint and hook are gone.
  const CSS = read('public/css/app.css');
  const phone = CSS.slice(CSS.indexOf('@media (max-width: 699.98px) {\n  /* #3726'));
  assert.ok(phone.length > 0, 'a phone block for the band');
  const block = phone.slice(0, phone.indexOf('\n}\n') + 3);
  // Where it rests: 18px above the HEADER'S MEASURED FOOT less #dev-body's
  // 8px (17px net) where the scroller scrolls, and the header's height less
  // the 17px tuck where the document scrolls. #3726: the foot is measured
  // (`--dev-ws-head-foot`, workshop.tsx) rather than assumed to be 7px over
  // the scroller's top, so in-flow chrome between the header and the frame
  // cannot open a gap; the 7px literal is only the pre-measurement fallback.
  assert.match(block, /#dev-workshop \{ --ws-band-top: calc\(var\(--dev-ws-head-foot, 7px\) - 17px\); \}/);
  assert.match(block, /html\[data-browser-scroller="dev-forum-scroll"\] #dev-workshop \{\s*--ws-band-top: calc\(var\(--browser-banner-h\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top\) - 17px\);/);
  assert.match(block, /\.dev-ws-tabs\.dev-ws-band \{\s*position: sticky;\s*top: var\(--ws-band-top\);\s*z-index: 29;/, 'sticky, over the cards, under the header');
  assert.match(block, /#dev-workshop \.dev-ws-pane-head \{ top: calc\(var\(--ws-band-top\) \+ 58px\); \}/, 'All items\' head pins under the band');
  // The two numbers the offsets are built from.
  assert.match(CSS, /^#dev-body:has\(> #dev-workshop\) \{ padding: 8px /m, '#dev-body\'s 8px top padding');
  assert.match(CSS, /^\.dev-ws-tabs\.dev-ws-band \{\s*margin: -18px /m, 'the band\'s 18px tuck');
});

test('a pull to refresh moves only the page under the tabs (pull-to-refresh under the tabs, evan, 2026-10-01)', () => {
  // "When you pull down on a community page, the tabs move down too? I think
  // the tabs should be fixed, and only the page under them move and reveal
  // the refresh." The kit slid the whole of #dev-forum-scroll, and the sticky
  // band lives in it. Measured at 390x844 with an iPhone agent and real touch
  // drags (Hub, Workshop and All items; installed and phone-browser layouts):
  // before, header 0 / band +76.5 / tab body +76.5 at a 76.5px pull; after,
  // header 0 / band 0 / tab body +76.5, the spinner between band and page.
  const CSS = read('public/css/app.css');
  const APP_VIEW = read('public/js/app-view.js');
  // The project page opts into the kit's two options, and no other pull does.
  assert.match(APP_VIEW, /PlatformUI\.pullToRefresh\(devScroll, \(\) => AppView\._loadDevFeed\(\), \{\s*pullProperty: '--dev-ptr-pull',\s*topEl: \(\) => devScroll\.querySelector\('\.dev-ws > \.dev-ws-band'\),\s*\}\);/,
    'the scroller carries the pull as a property, and the spinner hangs from the band');
  assert.equal((APP_VIEW.match(/pullProperty:/g) || []).length, 1);
  assert.doesNotMatch(read('public/js/app.js'), /pullProperty/, 'Home, Discover and Standings keep the kit\'s own pull');
  // What slides: everything after the band, and with no band (the Workshop
  // still loading) everything in the scroller. No fallback in the var(), so
  // at rest the declaration is invalid at computed-value time and leaves
  // `transform: none`: no stacking context or containing block until a pull.
  assert.match(CSS, /\n#dev-forum-scroll \.dev-ws > \.dev-ws-band ~ \*,\n#dev-forum-scroll:not\(:has\(\.dev-ws-band\)\) > \* \{\n  transform: translateY\(var\(--dev-ptr-pull\)\);\n\}/);
  assert.doesNotMatch(CSS, /var\(--dev-ptr-pull,/, 'no fallback: a 0px one would transform the tab body at rest');
  // #3514's paint for the gap under the header, and the hook that sized it,
  // are gone with the gap: a pull no longer opens one there.
  assert.doesNotMatch(CSS, /var\(--ptr-gap/, 'nothing paints by the old gap');
  assert.doesNotMatch(CSS, /> \.un-ptr-layer \{/, 'the kit\'s layer paints only its spinner again');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.doesNotMatch(ws, /function usePullGap|usePullGap\(hostRef\)|setProperty\('--ptr-gap'/, 'nor reads the kit\'s transform back');
  assert.match(ws, /usePinnedStrip\(bar, hostRef, tab\);\s*\/\/ NO PULL HOOK HERE ANY MORE/);
});

test('#3520: a short growing tab keeps one pixel to scroll, so the installed app bounces it', () => {
  // "Unable to over scroll down on hub page (but can on workshop)", in the
  // installed iPhone app, at both ends. Measured at 390x844 in that layout:
  // one scroller (#dev-forum-scroll) with the same overflow, overscroll and
  // touch-action on both tabs, no nested scroller on either, and the Hub at
  // scrollHeight 799 against clientHeight 799. The flex chain fills the
  // scroller with a short tab to exactly its height, iOS only rubber-bands a
  // box that can scroll, and the document under it is held still. With the
  // rule below the same Hub measured 800 against 799: one pixel of range.
  const CSS = read('public/css/app.css');
  const at = CSS.indexOf('@media (max-width: 699.98px) and (pointer: coarse) {\n  html:not([data-browser-scroller]) #dev-forum-scroll:has(');
  assert.ok(at > -1, 'a phone block for the scroller holding a growing tab');
  const block = CSS.slice(at, CSS.indexOf('\n}\n', at) + 3);
  const growing = '#dev-forum-scroll:has\\(> #dev-body > #dev-workshop > \\.dev-ws:not\\(\\[data-ws-tab="needs"\\]\\):not\\(\\[data-ws-tab="discussion"\\]\\)\\)';
  // Only where the scroller is the element, not the document (a phone
  // browser pages the document, and the pixel would lengthen the page), and
  // not the two fitted tabs, which scroll inside themselves.
  assert.match(block, new RegExp(`html:not\\(\\[data-browser-scroller\\]\\) ${growing} \\{\\s*position: relative;\\s*\\}`),
    'the scroller is the sentinel\'s containing block');
  assert.match(block, new RegExp(`html:not\\(\\[data-browser-scroller\\]\\) ${growing}::after \\{\\s*content: '';\\s*position: absolute; left: 0; bottom: -1px;\\s*width: 1px; height: 1px;\\s*pointer-events: none;\\s*\\}`),
    'a 1px box hung 1px below the scroller\'s bottom edge');
  // No percentage: a percentage floor in this chain is what Firefox dropped
  // (tests/dev-workshop.test.js), and the grow would absorb a spacer in flow.
  // Nor the scroller's padding, which is the tab-bar clearance (#3053).
  assert.doesNotMatch(block, /%/);
  assert.doesNotMatch(block, /padding|z-index/);
  // The two conditions it answers are still the case: the chain that fills a
  // short tab, and the installed shell's still document.
  assert.match(CSS, /#dev-forum-scroll:has\(> #dev-body > #dev-workshop\) \{ display: flex; flex-direction: column; \}/);
  assert.match(CSS, /html, body \{\s*height: 100dvh;\s*overflow: hidden;[\s\S]*?overscroll-behavior-y: none;\s*\}/);
  // And the pull at the top binds to that same scroller on every tab. (The
  // call takes options now: the tabs hold still during a pull, pinned in the
  // test above. Still that scroller, so still its one pixel of range.)
  assert.match(read('public/js/app-view.js'), /PlatformUI\.pullToRefresh\(devScroll, \(\) => AppView\._loadDevFeed\(\), \{/);
});
