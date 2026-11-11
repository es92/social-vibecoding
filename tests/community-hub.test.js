'use strict';

// A project's page is its community's HUB beside its WORKSHOP, and the
// channels live on the hubs rather than in Messages:
//
//   - the middle tab is Communities (frontend/src/features/nav/tab-bar.tsx),
//     with a count of the channels you have unread;
//   - a project's page has two tabs, the hub and the Workshop, with Needs you
//     and All items as pages under them (dev-board/workshop/workshop.tsx);
//   - the hub draws what is for you (the votes you owe, your work, the
//     channel's last line), how it's going and what went live recently
//     (dev-board/workshop/hub-cards.tsx);
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
const { message } = require('./lib/platform-i18n');

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

test('the rail reads Home, AI, Messages, you, and so does the phone\'s bar; Communities is drawn on neither and Discover is gone (#6019, One Home #6361)', () => {
  // A tab's label is a message id; the word is what the English catalog holds for it.
  const order = [...TABS.matchAll(/\{ key: '([a-z]+)' as const, label: '(core:tabs\.[A-Za-z]+)'/g)].map((m) => [m[1], message(m[2])]);
  // The markup is the desktop rail's order (Evan, 29 Oct 2026), the bot
  // above Messages since One Home (#6361).
  assert.deepEqual(order.map((o) => o[0]), ['ai', 'messages', 'workshop', 'me'],
    'after Home, whose entry is written across lines; Discover\'s tab is gone');
  // app.css lays the phone's four out with `order`, and hides the
  // Communities tab on both bars: Home holds your communities now.
  const css = read('public/css/app.css');
  const phone = css.slice(css.indexOf('/* TWO ORDERS, ONE MARKUP'));
  assert.match(phone, /#platform-tab-home \{ order: -4; \}\s*#platform-tab-ai \{ order: -3; \}\s*#platform-tab-messages \{ order: -2; \}/);
  assert.match(phone, /#platform-tab-workshop \{ display: none !important; \}/);
  assert.doesNotMatch(TABS, /key: 'discover'/);
  assert.deepEqual(order.find((o) => o[0] === 'ai'), ['ai', 'Homeroom bot'], 'the bot\'s own name (Evan, 29 Oct 2026)');
  assert.deepEqual(order.find((o) => o[0] === 'workshop'), ['workshop', 'Communities'],
    'the key stays `workshop`; the word is Communities');
  assert.match(TABS, /key: 'workshop' as const, label: 'core:tabs\.communities', href: '#communities', Icon: UserGroupIcon/);
  // The channels' count rides the Communities tab, the conversations' the
  // Messages tab, and the Messages store writes both.
  assert.match(TABS, /key === 'workshop' \? \(\s*<TabBadge count=\{communities\} id="platform-tabs-badge-communities"/);
  assert.match(STORE, /messages: state\.conversations\s*\.filter\(\(item\) => item\.kind !== 'channel' && !item\.homeroomBot && item\.unreadCount > 0\)\.length,/,
    'the bot\'s chat counts on AI, not Messages');
  assert.match(STORE, /communities: state\.conversations\.filter\(\(item\) => item\.kind === 'channel' && item\.unreadCount > 0\)\.length\s*\+ state\.discussions\.filter\(\(item\) => item\.section !== 'more' && \(item\.unreadCount \|\| 0\) > 0\)\.length,/);
});

test('a project page is its places, Hub, Needs you, Workshop and #general, with All items the Workshop\'s page (#852, #4417)', () => {
  const { pageParent, pageTitle } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const places = loadTsx('frontend/src/features/dev-board/workshop/places.ts');
  const { placeRows } = loadTsx('frontend/src/features/dev-board/workshop/project-places.tsx');
  // A project with no topics: the three pages, then #general.
  const rows = placeRows(null, 0);
  assert.deepEqual(rows.pages.map((p) => [p.key, p.label]), [['status', 'Hub'], ['needs', 'Needs you'], ['workshop', 'Workshop']]);
  assert.deepEqual([rows.general.key, rows.general.label], ['discussion', 'general']);
  assert.deepEqual(rows.topics, []);
  assert.equal(places.litPlace('all'), 'workshop', 'the Workshop stays lit over All items');
  assert.equal(pageParent('all'), 'workshop', 'All items goes back to the Workshop');
  // #4417: a channel's page is called by its handle: #general (was
  // Discussion), and a topic's channel by its own. A page's title is what
  // the English catalog holds for it.
  assert.deepEqual(['needs', 'workshop', 'all', 'discussion', 'c:onboarding', 'status'].map(pageTitle),
    ['Needs you', 'Workshop', 'All items', '#general', '#onboarding', 'Hub']);
  assert.equal(message('project:page.title.hub'), 'Hub');
  // The place bar on every page; All items adds its way back under it, the
  // first thing in its pinned head's one row (#4486), with no eyebrow, and
  // back is the Workshop place.
  assert.ok(!/pageBar/.test(LANDER), 'no back bar of its own');
  assert.equal(message('project:page.backToWorkshop'), 'Workshop');
  assert.match(LANDER, /<div className="dev-ws-allbar" data-ws-allbar="">\s*<PageBack\s+label=\{t\('project:page\.backToWorkshop'\)\}\s+title=\{pageTitle\(tab\)\}\s+onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}\s+eyebrow=\{false\}/);
  assert.match(LANDER, /\{band\}\s*\{tray\}/);
  // The hub's order, as agreed (the hub as the project's summary; 15 Oct
  // 2026): the hero (what it is, who is around, what you can do), the first
  // version while Homeroom bot builds it, with its maker's first look once
  // it is drawn (tests/hub-just-you.test.js, tests/hub-first-look.test.js),
  // Share it for a project that is just yours, "What do you want to change?"
  // for one nobody has started on, For you (Needs you, Your work, the
  // Discussion), and Recently live. One
  // column at every width, and no metrics card or chart anywhere on it.
  // Start a new change ended it until #852's review moved it into the
  // hero's ⋯ (tests/improve-action-deduplication.test.js).
  const hub = LANDER.slice(LANDER.indexOf("{tab === 'status' ? ("), LANDER.indexOf("{isChannelPlace(tab) ? ("));
  const order = ['<CommunityCard', '<FirstVersionCard', '<ShareItCard', '<StartHereBanner', '<ForYouCard', '<RecentlyLive']
    .map((x) => hub.indexOf(x));
  assert.ok(order.every((n) => n >= 0), `all six on the hub: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    'hero, first version, Share it, what to change, for you, recently live');
  assert.doesNotMatch(hub, /<SinceSummaryCard|<YourWorkCard|<NeedsCard|<ChannelCard|<GoingCard|ApprovalRules/,
    'what landed since your last visit, your work in full and the approval rule are the Workshop\'s');
  assert.doesNotMatch(hub, /data-ws-start-change/, 'no Start a new change at its foot');
  // Needs you's quiet line when no vote is owed (#3408), and none on a
  // project nobody else is in; the same from a project's first day.
  assert.match(hub, /queue=\{v\.queue\}\s+unclaimed=\{v\.dashboard \? v\.dashboard\.unclaimed : 0\}\s+mine=\{v\.mine\}\s+alone=\{alone\}/);
  assert.doesNotMatch(LANDER, /first_week|weekOne|hubWorkEmpty|workEmpty/, 'no first week of its own');
  // For somebody signed in who has not joined, the same row says "Up for a
  // vote · Join to vote on these." (the hand-off of 11 Nov 2026, `outsider`).
  assert.match(read(HUB), /\{owes\s*\? <NeedsRow queue=\{queue\} slug=\{slug\} canPost=\{canPost\} onOpen=\{onNeeds\} outsider=\{outsider\} \/>\s*: <NothingToVote unclaimed=\{claims\} onOpen=\{onWork\} alone=\{alone\} \/>\}/,
    'Needs you only while a vote is owed; one quiet line in its place otherwise, naming the open requests nobody has picked up as the way to the Workshop (Needs you is votes alone)');
  assert.match(read(HUB), /const claims = Math\.max\(0, Number\(unclaimed\) \|\| 0\);/, 'the requests are the view model\'s unclaimed count, not queue rows');
  // Each row is a door to its place.
  assert.match(hub, /onNeeds=\{\(\) => openTab\('needs'\)\}\s+onWork=\{\(\) => openTab\('workshop'\)\}\s+onDiscussion=\{\(\) => openTab\('discussion'\)\}/);
  assert.match(hub, /<RecentlyLive slug=\{slug\} rows=\{v\.recentLive\} onAll=\{\(\) => openTab\('workshop'\)\} own=\{ownLive\} ident=\{recentIdent\} month=\{community\?\.activity\?\.shipped_month\} \/>/, 'All in Workshop is the Workshop place, and so is "N more live this month"');
  const { ForYouCard } = loadTsx(HUB);
  const quiet = renderToHtml(createElement(ForYouCard, {
    slug: 'garden', queue: [], mine: null, alone: true,
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, canPost: true,
    data: community({ channel: { recent: [], unread_count: 0, href: '#messages/app/garden', handle: null } }),
  }));
  assert.match(quiet, /<span data-ws-channel-empty="">No messages yet\.<\/span>/,
    'with nothing said yet the Discussion row says so, and opens the Discussion place');
  assert.doesNotMatch(hub, /<WorkshopDoor|dev-ws-hub-side|data-ws-since=""/, 'no Workshop door, no second column, and the since list is the Workshop\'s');
  assert.doesNotMatch(read('public/css/app.css'), /dev-ws-hub-side/);
  // Discussion is the channel whole; #4417: and so is each topic's channel.
  assert.match(LANDER, /\{isChannelPlace\(tab\) \? \(\s*<ProjectDiscussion\s+slug=\{slug\}/);
  // The Workshop tab (After-Workshop-B): OVERVIEW, All items with See all,
  // where the open work is and the approval rule as its last line (no
  // notices panel since the #4698 follow-up); then YOUR WORK, one row that
  // opens the Homeroom bot tab narrowed to the project (5 Nov 2026: it was
  // What's happening, your work and what is new for you); WHAT HAPPENED,
  // this week and a row for each week before it, its new requests nobody has
  // picked up ending with Build it.
  const ws = LANDER.slice(LANDER.indexOf("{tab === 'workshop' && !weekUp ? ("), LANDER.indexOf("{tab === 'needs' ? ("));
  const w = (x) => ws.indexOf(x);
  // #4457: a week's page replaces the tab's body.
  const wsOrder = ['data-ws-part="overview"', 'data-ws-dashboard=""', '<ApprovalLine', '<YourWorkCard',
    'data-ws-happened-head=""', 'data-ws-part="happened"', 'data-ws-happened=""', '<ThisWeek', '<WeekRow'].map(w);
  assert.ok(wsOrder.every((n) => n >= 0), `every section is on the tab: ${JSON.stringify(wsOrder)}`);
  assert.deepEqual([...wsOrder].sort((a, b) => a - b), wsOrder,
    'Overview (All items and the rule), Your work, then What happened');
  assert.ok(!/<WorkshopNotices|data-ws-notices/.test(ws), 'and no Lately in this project panel');
  assert.ok(!/data-ws-since=""|data-ws-weeks=""|<ApprovalRules/.test(ws), 'Since your last visit, Week by week and the rules card are gone');
  assert.match(ws, /\{slug && v\.mine && v\.mine\.viewer \? <YourWorkCard slug=\{slug\} name=\{projectName\} \/> : null\}/,
    'your work is one row, for a signed-in viewer');
  assert.ok(!/data-ws-mine=|data-ws-fresh|data-ws-part="happening"/.test(ws), 'and What\'s happening is gone');
  assert.match(ws, /act=\{freshAct\}/, 'What happened\'s new requests end with Build it');
  assert.equal(message('project:workshop.allItems.title'), 'All items');
  assert.match(ws, /<span className="dev-ws-head-title">\{t\('project:workshop\.allItems\.title'\)\}<\/span>\s*<button[\s\S]*?data-ws-all-open=""\s*onClick=\{\(\) => openTab\('all'\)\}/);
  // The Overview label opens the Workshop page, All items straight under it;
  // the approval rule is the card's last line, and only there.
  assert.match(ws, /^\{tab === 'workshop' && !weekUp \? \(\n\s*<>\n\s*\{\/\*(?:(?!\*\/)[\s\S])*\*\/\}\n\s*<SectionHeader className="px-1\.5 pb-0 pt-2" data-ws-part="overview">\{t\('project:workshop\.part\.overview'\)\}<\/SectionHeader>\n\s*\{v\.dashboard \? \(\s*<section\s+className="dev-ws-strip"\s+data-ws-dashboard=""/,
    'the Overview opens the Workshop page');
  assert.match(ws, /\{slug \? <ApprovalLine slug=\{slug\} \/> : null\}\n\s*<\/section>/, 'the rule ends the card');
  assert.equal(ws.split('<ApprovalLine').length - 1, 1, 'and only there');
  const all = LANDER.slice(LANDER.indexOf("{tab === 'all' ? ("));
  assert.ok(!all.slice(0, all.indexOf('data-ws-pane=""')).includes('<ApprovalLine'), 'and All items does not lead with it');
  // `?ws=discussion` is a deep link like the others, and so is `?ws=plan`,
  // the plan for the people who joined (#4074), a page under the Hub that is
  // visited and never reopened on.
  const av = read('public/js/app-view.js');
  // 16 Oct 2026: and `?ws=bot`, Homeroom bot's slots, a page under the Workshop.
  assert.match(av, /WORKSHOP_TABS: \['status', 'discussion', 'workshop', 'needs', 'all', 'plan', 'bot'\],/);
  // #4417: and so is a topic's channel, `c:<handle>`, a place like the others.
  assert.match(av, /_isWorkshopPlace\(key\) \{\n\s*return AppView\.WORKSHOP_TABS\.indexOf\(key\) !== -1\n\s*\|\| \(typeof key === 'string' && AppView\.WORKSHOP_CHANNEL_RE\.test\(key\)\);/);
  assert.match(av, /const next = AppView\._isWorkshopPlace\(key\) && key !== 'plan' \? key : 'status';/);
  assert.match(av, /if \(AppView\._isWorkshopPlace\(stored\) && stored !== 'plan'\) return stored;/);
  const { litPlace } = loadTsx('frontend/src/features/dev-board/workshop/places.ts');
  assert.equal(litPlace('plan'), 'status', 'Hub stays lit over the plan');
  assert.equal(litPlace('all'), 'workshop');
  assert.equal(litPlace('bot'), 'workshop', 'and over the bot\'s slots');
});

test('For you\'s Discussion row: the channel\'s name, its last line, what is new, and the way in', () => {
  const { ForYouCard } = loadTsx(HUB);
  const card = (data, over = {}) => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', queue: [], mine: null, alone: false, canPost: true,
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, data, ...over,
  }));
  const html = card(community());
  assert.match(html, /<button type="button" class="[^"]*dev-ws-foryou-row[^"]*" data-ws-channel="preview" data-ws-channel-open="">/,
    'one door, to the Discussion place');
  assert.match(html, />Discussion <span class="dev-ws-foryou-handle">#general<\/span><\/div>/, 'the project\'s channel is its #general');
  assert.match(html, /<span data-ws-channel-last=""><span data-ws-channel-said="">@lin: See you Sunday<\/span><span data-ws-channel-ago=""> · [^<]+<\/span><\/span>/,
    'the newest line, who said it and when: the words give way, the time stays whole (audit P04)');
  assert.doesNotMatch(html, /Who has seeds/, 'the rest are the Discussion\'s');
  assert.match(html, /<span class="dev-ws-foryou-pill" data-ws-channel-unread="2">2 new<\/span>/, 'what is new since you last read it, its one pill');
  assert.doesNotMatch(html, /data-ws-channel-compose|<form/, 'no composer on the hub');
  // Homeroom's: #general by its own handle.
  const homeroom = card(community({ channel: { ...community().channel, href: '#messages/1', handle: 'general', unread_count: 0 } }));
  assert.match(homeroom, /data-ws-channel-handle="general"/);
  assert.doesNotMatch(homeroom, /data-ws-channel-unread/, 'nothing new, no pill');
  // A multi-line message is one line in the row.
  const long = card(community({ channel: { ...community().channel, recent: [{ id: 3, content: 'one\n\ntwo', created_at: '2026-09-20T10:00:00Z', by: null }] } }));
  assert.match(long, /<span data-ws-channel-last=""><span data-ws-channel-said="">one two<\/span><span data-ws-channel-ago=""> · /);
  const css = read('public/css/app.css');
  assert.match(css, /\[data-ws-channel-last\] > \[data-ws-channel-said\] \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\[data-ws-channel-last\] > \[data-ws-channel-ago\] \{ flex: none;/);
  // The count is new to read, grey as the sidebar's beside it; the accent is a vote's (audit N04).
  assert.match(css, /\.dev-ws-foryou-pill\[data-ws-channel-unread\] \{ background: var\(--text-faint, #8e8e93\); \}/);
  // Nothing to draw for a viewer who may not talk here. A project that is
  // just yours has its room from the first day (15 Oct 2026), saying so
  // while nothing is said in it.
  assert.doesNotMatch(card(community({ channel: null })), /data-ws-channel/);
  const solo = card(community({ audience: 'solo', audience_label: 'Just you', member_count: 1,
    channel: { recent: [], unread_count: 0, last_at: null, href: '#messages/app/garden', handle: null } }), { alone: true });
  assert.match(solo, /data-ws-channel="preview" data-ws-channel-open=""[\s\S]*<span data-ws-channel-empty="">No messages yet\.<\/span>/);
  assert.equal(message('project:hub.channel.empty'), 'No messages yet.');
  assert.equal(card(null, { alone: true }), '', 'nothing before the read on a project nobody else is in');
});

test('For you\'s Needs you opens the queue and counts the votes owed', () => {
  const { ForYouCard } = loadTsx(HUB);
  const row = (key, title, who) => ({ t: 'card', key, card: { title: { text: title } }, who, kind: 'vote' });
  const card = (queue, canPost = true) => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', name: 'Garden', queue, mine: null, workEmpty: null, alone: false, canPost,
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, data: community({ channel: null }),
  }));
  const needs = card([row('a', 'Dark mode', 'ada'), row('b', 'Tags', 'lin'), row('c', 'Export', 'kai')]);
  assert.match(needs, /^<section class="dev-ws-hub-section" data-ws-hub-for-you="" aria-labelledby="([^"]+)"><h2 class="[^"]*uppercase[^"]*" id="\1">For you<\/h2><div class="dev-ws-strip dev-ws-foryou">/,
    'the small-caps label over one card');
  assert.match(needs, /<div class="dev-ws-foryou-item" data-ws-hub-needs="" data-ws-hub-needs-votes="3"><button type="button" class="[^"]*" data-ws-hub-needs-open="">/);
  assert.match(needs, />Needs you<\/div><div class="[^"]*"><span data-ws-hub-needs-first="">Dark mode, and 2 more<\/span><\/div><\/div><span class="dev-ws-foryou-pill">3 to vote<\/span>/);
  assert.equal((needs.match(/dev-ws-foryou-pill/g) || []).length, 1, 'one pill on the row');
  assert.doesNotMatch(needs, /Join to vote/);
  assert.match(card([row('a', 'Dark mode', 'ada')]), /<span data-ws-hub-needs-first="">Dark mode<\/span>/, 'one vote: its title alone');
  const outsider = card([row('a', 'Dark mode', 'ada')], false);
  assert.match(outsider, /<p class="dev-ws-hub-needs-join" data-ws-hub-needs-join="">Join to vote on these\.<\/p>/);
  assert.doesNotMatch(needs, /data-ws-hub-needs-none/, 'the door says nothing about an empty queue: it is not drawn then');
  // #3408: no vote owed, no door. One quiet line says so.
  const { NothingToVote, owesVote } = loadTsx(HUB);
  assert.equal(owesVote([]), false);
  const none = renderToHtml(createElement(NothingToVote, { unclaimed: 0, onOpen: () => {} }));
  assert.equal(none, '<p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on.</p>');
  assert.match(card([]), /<div class="dev-ws-strip dev-ws-foryou"><p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on\.<\/p><\/div>/);

  // Members & activity is the hero's since #3268, and the fortnight How
  // it's going's: pinned in tests/community-hub-details.test.js.
  assert.equal(loadTsx(HUB).MembersCard, undefined, 'no separate Members & activity card');
  assert.equal(loadTsx(HUB).NeedsCard, undefined, 'and no Needs you card beside the For you row');
});

test('Recently live: the last three changes that went live, as pictures that open their pages', () => {
  const { RecentlyLive, RECENT_LIVE_SHOWN } = loadTsx(HUB);
  assert.equal(RECENT_LIVE_SHOWN, 3);
  const r = (id, over = {}) => ({
    key: `live:${id}`, sessionId: id, prNumber: 900 + id, title: `Change ${id}`, who: 'Homeroom bot',
    at: new Date(Date.now() - 3600 * 1000).toISOString(), going: false, picture: null, ...over,
  });
  const html = renderToHtml(createElement(RecentlyLive, {
    slug: 'garden',
    onAll: () => {},
    rows: [
      r(1, { picture: '/api/apps/garden/proposals/1/shots/0123456789abcdef0123456789abcdef' }),
      r(2),
      r(3, { going: true, at: null }),
      r(4),
    ],
  }));
  assert.match(html, /^<section class="dev-ws-hub-section" data-ws-hub-recent="" aria-labelledby="([^"]+)"><div class="dev-ws-hub-sechead"><h2 class="[^"]*uppercase[^"]*" id="\1">Recently live<\/h2><button type="button" class="dev-ws-hub-open un-touch-target" data-ws-recent-all="">All in Workshop<svg/,
    'the label, and its door to the Workshop');
  const cards = [...html.matchAll(/<a class="dev-ws-recent-card" href="([^"]+)" data-ws-recent-item="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cards, [
    ['#app/garden/dev/changes/901', 'live:1'], ['#app/garden/dev/changes/902', 'live:2'], ['#app/garden/dev/changes/903', 'live:3'],
  ], 'the newest three, each its change\'s page');
  assert.match(html, /<span class="dev-ws-recent-pic" data-ws-recent-pic="shot" aria-hidden="true"><img src="\/api\/apps\/garden\/proposals\/1\/shots\/0123456789abcdef0123456789abcdef" alt="" loading="lazy" draggable="false"\/><\/span><span class="dev-ws-recent-title">Change 1<\/span><span class="dev-ws-recent-meta" title="[^"]+">Homeroom bot · 1h ago<\/span>/,
    'its after shot, its title, and who and when');
  assert.match(html, /data-ws-recent-pic="plain" aria-hidden="true"><svg[^>]*class="dev-ws-recent-glyph"/, 'without a shot, a plain tile');
  assert.match(html, /data-ws-recent-item="live:3" data-ws-recent-going="">[\s\S]*?<span class="dev-ws-recent-meta dev-ws-recent-going">Homeroom bot · going live now<\/span>/);
  assert.equal(renderToHtml(createElement(RecentlyLive, { slug: 'garden', rows: [], onAll: () => {} })), '', 'nothing merged, no section');

  // NEVER EMPTY (15 Oct 2026): before any change has gone live, one card
  // for the app itself, its tile and name and since when it has been live,
  // opening the app. Its label has no door: nothing has landed to list.
  const { liveSinceLine } = loadTsx(HUB);
  const own = (since, rows = []) => renderToHtml(createElement(RecentlyLive, {
    slug: 'garden', rows, onAll: () => {}, own: { name: 'Garden', iconUrl: null, iconEmoji: '🌱', since },
  }));
  const today = own(new Date().toISOString());
  assert.match(today, /^<section class="dev-ws-hub-section" data-ws-hub-recent="" aria-labelledby="([^"]+)"><div class="dev-ws-hub-sechead"><h2 class="[^"]*" id="\1">Recently live<\/h2><\/div><div class="dev-ws-strip dev-ws-recent"><ul class="dev-ws-recent-list"><li class="dev-ws-recent-item"><button type="button" class="dev-ws-recent-card" data-ws-recent-own="">/,
    'the label, then the app\'s own card, a button');
  assert.match(today, /<span class="dev-ws-recent-pic" data-ws-recent-pic="app" aria-hidden="true"><span class="app-icon-tile dev-ws-recent-app" data-icon="emoji">[\s\S]*?🌱[\s\S]*?<\/span><\/span><span class="dev-ws-recent-title">Garden<\/span><span class="dev-ws-recent-meta" data-ws-recent-since="">Live since today<\/span><\/button><\/li><\/ul>/,
    'its tile where a change\'s picture would be, its name, and since when');
  assert.doesNotMatch(today, /data-ws-recent-all|data-ws-recent-item=/);
  assert.match(read(HUB), /function openApp\(slug: string\): void \{\s*\(window as any\)\.App\?\.openAppTab\?\.\(slug, 'app'\);\s*\}/, 'it opens the app');
  assert.match(read(HUB), /data-ws-recent-own="" onClick=\{\(\) => openApp\(slug\)\}/);
  assert.doesNotMatch(own(new Date().toISOString(), [r(1)]), /data-ws-recent-own/, 'once a change is live, the changes alone');
  assert.equal(own(null), '', 'an app that has never run is not live: no section');
  // In words, the reader's day: today, or the day it went live.
  const at = (iso) => new Date(iso).getTime();
  assert.equal(liveSinceLine('2026-10-15T08:00:00', at('2026-10-15T20:00:00')), 'Live since today');
  assert.match(liveSinceLine('2026-10-12T08:00:00', at('2026-10-15T20:00:00')), /^Live since (October 12|12 October)$/);
  assert.match(liveSinceLine('2025-12-30T08:00:00', at('2026-10-15T20:00:00')), /^Live since .*December.*2025$/, 'with the year when it is not this one');
  assert.equal(liveSinceLine('2026-10-16T08:00:00', at('2026-10-15T20:00:00')), 'Live since today', 'a clock ahead of the reader\'s says today');
  assert.equal(liveSinceLine(null), '');
  assert.equal(message('project:hub.recent.own.since'), 'Live since {{date}}');
  // The page draws the app's card only once the app is live: never while
  // Homeroom bot still builds its first version, and not on Homeroom's own
  // page, which has no App tab.
  assert.match(LANDER, /const firstLive = !community\?\.first_version \|\| community\.first_version\.line === 'live';\s*const ownLive = !actions\.selfHosted && community && community\.live_since && firstLive \? \{/);

  // The rows: the newest merged changes from the loaded Completed stream,
  // with the after still the Needs-you feed reads from their shots.
  const av = read('public/js/app-view.js');
  const fn = av.slice(av.indexOf('  _workshopRecentLive(limit'), av.indexOf('  // The first before/after capture pair, as the Needs-you feed\'s picture.'));
  assert.match(fn, /\.filter\(\(m\) => m && m\.row_type !== 'close_issue' && m\.id != null\s*&& m\.deployment_state !== 'failed' && m\.deployment_state !== 'stalled'\)\s*\.slice\(0, limit\);/);
  assert.match(fn, /const pictures = AppView\._workshopVisuals\(null, m\.shots \|\| null\);/);
  assert.match(fn, /who: AppView\._botBuilt\(m\) \? PlatformI18n\.t\('changes:workshop\.row\.byBot'\) : \(raw \|\| null\),/);
  assert.match(av, /recentLive: AppView\._workshopRecentLive\(\),/);
  assert.match(av, /WORKSHOP_RECENT_LIVE_MAX: 3,/);
});

test('an open channel lights Communities and hangs off its hub; Messages lists people and agents', () => {
  assert.match(STORE, /export function channelHub\(\): string \| null \{\s*[\s\S]{0,120}if \(state\.route\.appSlug\) return `#app\/\$\{encodeURIComponent\(state\.route\.appSlug\)\}\/dev\/hub`;/);
  assert.match(STORE, /if \(!row \|\| row\.kind !== 'channel'\) return null;/, '#general is the channel among the conversations');
  assert.match(STORE, /navStore\.set\(\{ tab: hub \? 'workshop' : 'messages' \}\);/);
  assert.match(STORE, /app\.setBackIcon\?\.\('arrow', hub\);/);
  assert.match(STORE, /if \(!state\.route\.threadRootId && channelHub\(\)\) return false;/,
    'Back on a phone follows the arrow to the hub rather than to the list');
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const channelOpen = !!snap\.route\.appSlug\s*\|\| \(!!snap\.route\.conversationId && snap\.active\?\.id === snap\.route\.conversationId && snap\.active\?\.kind === 'channel'\);/);
  const inbox = read('frontend/src/features/messages/inbox.ts');
  assert.match(inbox, /if \(item\.kind === 'channel' \|\| item\.homeroomBot\) continue;/,
    'channels are on their hubs, and the bot\'s chat is the AI tab (#6019)');
  assert.match(inbox, /agents\.sort\(byClock\);\n\s+people\.sort\(byClock\);/);
  // Agents and People, each in the order things happened.
  assert.match(inbox, /return \[\.\.\.agents, \.\.\.people\];/);
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
  assert.match(CSS, /#dev-workshop > \.dev-ws\[data-ws-tab="discussion"\],\s*#dev-workshop > \.dev-ws\[data-ws-tab\^="c:"\] \{ min-height: 0; \}/);
  // #4417: a topic's channel (`c:<handle>`) is fitted the same way as #general.
  assert.match(CSS, /html\[data-browser-scroller\] \.dev-ws\[data-ws-tab="discussion"\],\s*html\[data-browser-scroller\] \.dev-ws\[data-ws-tab\^="c:"\] \{\s*height: var\(--ws-fit\);/);
  assert.match(CSS, /\.dev-ws-discussion \.platform-safe-bar \{ padding-bottom: 0\.5rem !important; \}/);
});

test('#3499: the band and the Discussion pane bleed to the screen\'s edges, not past them', () => {
  // Holding the Workshop, #dev-body narrows its sides from `px-3`'s 12px to
  // 4px. The band and the Discussion pane bled 12 against it and ran 8px
  // past both edges of a phone, and where #dev-forum-scroll is the scroller
  // (an installed app, the native WebView) the hub scrolled sideways by 8px.
  // Each bleed has to cancel exactly the padding it sits in.
  const CSS = read('public/css/app.css');
  const body = CSS.match(/^#dev-body:has\(> #dev-workshop\) \{ padding-block: [^;]+; padding-inline: (\d+)px; \}/m);
  assert.ok(body, '#dev-body has its Workshop side padding');
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
  assert.match(block, /#dev-workshop \.dev-ws-pane-head \{ top: calc\(var\(--ws-band-top\) \+ 18px\); \}/, 'All items\' head pins under the band');
  // The two numbers the offsets are built from.
  assert.match(CSS, /^#dev-body:has\(> #dev-workshop\) \{ padding-block: 8px /m, '#dev-body\'s 8px top padding');
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
  assert.match(APP_VIEW, /PlatformUI\.pullToRefresh\(devScroll, \(\) => AppView\._loadDevFeed\(\), \{\s*pullProperty: '--dev-ptr-pull',\s*topEl: \(\) => \{\s*const band = devScroll\.querySelector\('\.dev-ws > \.dev-ws-band'\);\s*devScroll\.classList\.toggle\('dev-ws-has-band', !!band\);\s*return band;\s*\},\s*\}\);/,
    'the scroller carries the pull as a property, and the spinner hangs from the band');
  assert.equal((APP_VIEW.match(/pullProperty:/g) || []).length, 1);
  assert.doesNotMatch(read('public/js/app.js'), /pullProperty/, 'Home, Discover and Standings keep the kit\'s own pull');
  // What slides: everything after the band, and with no band (the Workshop
  // still loading) everything in the scroller. No fallback in the var(), so
  // at rest the declaration is invalid at computed-value time and leaves
  // `transform: none`: no stacking context or containing block until a pull.
  // "No band" is a class the scroller carries (`dev-ws-has-band`, absent),
  // not `:not(:has(.dev-ws-band))`: asked as `:has()` on the scroller, the
  // answer could change with any node added to the board, and the browser
  // re-applied the stylesheet to all of it each time. The pull reads the band
  // again as it starts (the `topEl` above), so the class is right when used.
  assert.match(CSS, /\n#dev-forum-scroll \.dev-ws > \.dev-ws-band ~ \*,\n#dev-forum-scroll:not\(\.dev-ws-has-band\) > \* \{\n  transform: translateY\(var\(--dev-ptr-pull\)\);\n\}/);
  assert.doesNotMatch(CSS, /#dev-forum-scroll:not\(:has\(\.dev-ws-band\)\)\s*>\s*\*\s*\{/);
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
  const growing = '#dev-forum-scroll:has\\(> #dev-body > #dev-workshop > \\.dev-ws:not\\(\\[data-ws-tab="needs"\\]\\):not\\(\\[data-ws-tab="discussion"\\]\\):not\\(\\[data-ws-tab\\^="c:"\\]\\)\\)';
  // Only where the scroller is the element, not the document (a phone
  // browser pages the document, and the pixel would lengthen the page), and
  // not the two fitted tabs, which scroll inside themselves.
  assert.match(block, new RegExp(`html:not\\(\\[data-browser-scroller\\]\\) ${growing} \\{\\s*position: relative;\\s*\\}`),
    'the scroller is the sentinel\'s containing block');
  assert.match(block, new RegExp(`html:not\\(\\[data-browser-scroller\\]\\) ${growing}::after \\{\\s*content: '';\\s*position: absolute; inset-inline-start: 0; bottom: -1px;\\s*width: 1px; height: 1px;\\s*pointer-events: none;\\s*\\}`),
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

test('the Hub has one large heading on a wide window, and a phone\'s 16px gutter (audit P02, P03)', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-placebar\[data-place-bar="status"\] \.dev-ws-place-title \{ font-size: 15px; font-weight: 600; color: var\(--text-muted\); \}/,
    'on the Hub the hero\'s name is the heading; "Hub" is the band\'s quiet name');
  assert.match(css, /@media \(max-width: 767\.98px\) \{\s*\.dev-ws\[data-ws-tab="status"\] > \.dev-ws-tabbody \{ padding-inline: 12px; \}\s*\.dev-ws\[data-ws-tab="status"\] > \.dev-ws-tabbody > \.dev-ws-hero \{ padding-inline: 0; \}/,
    'the column starts 4px in: 12 more puts the cards, the tile and the labels on 16');
});
