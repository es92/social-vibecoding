'use strict';

// The hub's details and the loose ends around it (communities, after #3261):
//
//   - who a project is for can grow from its page: "Make it public" on the
//     hero, or "Make it private" in its ⋯, opens the visibility proposal
//     (dev-board/workshop/community-card.tsx);
//   - the hub's head names the project and who is around this week (and
//     draws no chart), For you's Needs you counts the votes you owe, and a
//     person who has not joined sees "Recently" (dev-board/workshop/);
//   - a Mayor card refused for membership offers Join (features/agent-session);
//   - a Homeroom line kept in #general is drawn as Homeroom's (Homeroom
//     writes none into a channel now: tests/channel-activity.test.js);
//   - Discover's rows open the hub, its controls sit over the list's card,
//     the Communities toggle is the project page's strip, and Home's Browse
//     all links carry the accent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const CARD_SRC = read(CARD);
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');

const community = (over = {}) => ({
  slug: 'garden',
  name: 'Garden',
  member_count: 12,
  is_member: true,
  is_creator: false,
  audience: 'open',
  audience_label: 'Public community',
  members: [{ id: 1, username: 'ada' }, { id: 2, username: 'lin' }],
  channel: null,
  activity: { active_week: 4, shipped_month: 3 },
  approval: { policy: 'anyone', approvals_required: null, electorate: 12, required: 5 },
  ...over,
});

const days = (counts) => counts.map((n, i) => ({ day: `2026-09-${String(10 + i).padStart(2, '0')}`, n }));

test('#3268: the hub\'s head is what it is and who is around this week', async () => {
  const { HeroPeople, HeroActive, HERO_FACES, CommunityCard, reloadCommunity } = loadTsx(CARD);
  const members = ['ada', 'lin', 'kai', 'mia', 'sam', 'zoe', 'raj'].map((u, i) => ({ id: i + 1, username: u }));
  const people = renderToHtml(createElement(HeroPeople, { members, count: 19 },
    createElement('span', { className: 'dev-ws-hero-actions' }, 'Invite')));
  assert.equal(HERO_FACES, 5);
  assert.equal([...people.matchAll(/class="dev-ws-hero-face"/g)].length, 5, 'five faces, then the count says the rest');
  assert.match(people, /<span class="dev-ws-hero-count" data-ws-members-cell="members">19 members<\/span><span class="dev-ws-hero-actions">Invite<\/span>/,
    'the invite preview\'s people row: the count, then what it holds');

  // WHO IS AROUND, BY NAME: this week's people (activitySummary
  // `active_people`, most recent first), "+N" for the rest of the week's
  // count, "40 active this week" over their names. 15 over 13.
  const active = (activity) => renderToHtml(createElement(HeroActive, { activity }));
  const five = ['evan', 'talha', 'zura', 'scraido2', 'kempis'].map((u, i) => ({ id: i + 1, username: u, display_name: null }));
  const html = active({ active_week: 40, shipped_month: 0, daily: [], active_people: five });
  assert.match(html, /^<div class="dev-ws-hero-active" data-ws-members="" data-ws-active-people="40"><span class="dev-ws-hero-faces" aria-hidden="true">/, 'the faces lead the row');
  assert.deepEqual([...html.matchAll(/class="dev-ws-hero-face"[^>]*title="@([^"]+)">([A-Z])</g)].map((m) => [m[1], m[2]]),
    [['evan', 'E'], ['talha', 'T'], ['zura', 'Z'], ['scraido2', 'S'], ['kempis', 'K']], 'a face each, in the order the server gave');
  assert.match(html, /<span class="dev-ws-hero-face dev-ws-hero-face-more">\+35<\/span><\/span>/, 'then the rest, counted');
  assert.match(html, /<span class="dev-ws-hero-active-n" data-ws-members-cell="active">40 active this week<\/span><span class="dev-ws-hero-active-names" data-ws-active-names="">evan, talha, zura, scraido2, kempis and 35 more<\/span>/);
  const few = active({ active_week: 2, active_people: five.slice(0, 2) });
  assert.match(few, />2 active this week<\/span><span class="dev-ws-hero-active-names" data-ws-active-names="">evan, talha<\/span>/, 'everyone named: no "and 0 more"');
  assert.doesNotMatch(few, /dev-ws-hero-face-more/);
  assert.equal(active({ active_week: 0, active_people: [] }), '', 'a quiet week says nothing');
  assert.match(active({ active_week: 3 }), /^<div class="dev-ws-hero-active"[^>]*><span class="dev-ws-hero-active-words"><span[^>]*>3 active this week<\/span><\/span><\/div>$/,
    'an older server without the names: the count alone');

  // THE HEAD, rendered from the shared read: the tile and the name (the
  // page's one large heading) over "Public community · 266 members", the
  // description, who is around, then the row of actions with the ⋯ last.
  const payload = (over = {}) => ({
    slug: 'garden-head', name: 'Garden', description: 'Seeds, swaps and Sunday digs.',
    member_count: 266, is_member: true, is_creator: false, audience: 'open', audience_label: 'Public community',
    members, channel: null,
    activity: { active_week: 40, shipped_month: 9, daily: days(Array(14).fill(1)), active_people: five },
    approval: { policy: 'anyone', approvals_required: null, electorate: 12, required: 5 },
    ...over,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const slug = String(url).match(/\/api\/apps\/([^/]+)\/community/)[1];
    return { ok: true, json: async () => (slug === 'garden-solo'
      ? payload({ slug, audience: 'solo', audience_label: 'Just you', member_count: 1 })
      : slug === 'garden-solo-outside'
        ? payload({ slug, audience: 'solo', audience_label: 'Just you', member_count: 1, is_member: false })
        : payload({ slug })) };
  };
  try {
    await reloadCommunity('garden-head');
    await reloadCommunity('garden-solo');
    const menu = createElement('span', { className: 'dev-ws-plus' }, createElement('button', { id: 'dev-plus-btn' }));
    const hero = renderToHtml(createElement(CommunityCard, { slug: 'garden-head', name: 'Garden', iconEmoji: '🌱', menu }));
    assert.match(hero, /^<section class="dev-ws-hero dev-ws-hero-summary" data-ws-community="" data-audience="open">/);
    assert.match(hero, /<div class="dev-ws-hero-id" data-ws-community-id=""><span class="app-icon-tile dev-ws-hero-tile" data-icon="emoji" aria-hidden="true"><span[^>]*>🌱<\/span><\/span><span class="dev-ws-hero-id-text"><h1 class="dev-ws-hero-name" data-ws-community-name="">Garden<\/h1><span class="dev-ws-hero-id-sub" data-ws-members-cell="members"><span class="dev-ws-hero-audience" data-ws-community-audience="">Public community<\/span> · 266 members<\/span><\/span><\/div>/,
      'the tile and the name over who it is for and how many are in it');
    const at = (needle) => hero.indexOf(needle);
    const order = ['data-ws-community-id=""', 'data-ws-community-description=""', 'data-ws-active-people="40"', 'class="dev-ws-hero-row"'].map(at);
    assert.ok(order.every((n) => n > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'what it is, what it is for, who is around, then what you can do');
    assert.match(hero, /<div class="dev-ws-hero-actions"><button[^>]*data-ws-community-invite=""[^>]*>Invite<\/button><span class="dev-ws-plus"><button id="dev-plus-btn"><\/button><\/span><\/div>/,
      'Invite, then the ⋯, last');
    assert.doesNotMatch(hero, /data-ws-members-trend|shipped this month/, 'no chart and nothing about what shipped');
    // Just you: the label alone under the name, and nobody else to name.
    // #4896: to its one member it is "Just you so far", and Invite is in
    // the row of what they can do (it was the Share it card's alone).
    const solo = renderToHtml(createElement(CommunityCard, { slug: 'garden-solo', name: 'Garden', menu }));
    assert.match(solo, /<h1 class="dev-ws-hero-name" data-ws-community-name="">Garden<\/h1><span class="dev-ws-hero-id-sub" data-ws-members-cell="members"><span class="dev-ws-hero-audience" data-ws-community-audience="">Just you so far<\/span><\/span>/);
    assert.match(solo, /<div class="dev-ws-hero-actions"><button[^>]*data-ws-community-invite=""[^>]*>Invite<\/button><span class="dev-ws-plus"><button id="dev-plus-btn"><\/button><\/span><\/div>/,
      'Invite, then the ⋯');
    assert.doesNotMatch(solo, /data-ws-active-people/, 'no faces: nobody else to name');
    // Somebody outside it (an admin's look) reads the audience's name, and
    // is offered no Invite: making a link is a member's.
    await reloadCommunity('garden-solo-outside');
    const outside = renderToHtml(createElement(CommunityCard, { slug: 'garden-solo-outside', name: 'Garden', menu }));
    assert.match(outside, /data-ws-community-audience="">Just you<\/span>/);
    assert.doesNotMatch(outside, /Just you so far|data-ws-community-invite/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const hero = CARD_SRC.slice(CARD_SRC.indexOf('export function CommunityCard('), CARD_SRC.indexOf('export function shareItLine('));
  assert.match(hero, /\{week \? null : \(\s*<HeroIdentity slug=\{slug\} name=\{displayName\} iconUrl=\{iconUrl\} iconEmoji=\{iconEmoji\} data=\{data\} member=\{member\} \/>\s*\)\}\s*\{data\.description && !week \? descLine : null\}/);
  assert.match(hero, /\{week \|\| solo \? null : <HeroActive activity=\{data\.activity\} \/>\}/);
  assert.ok(hero.indexOf('<HeroActive') < hero.lastIndexOf('<div className="dev-ws-hero-row">'), 'then what you can do');
  assert.ok(hero.lastIndexOf('<div className="dev-ws-hero-row">') < hero.indexOf('{data.description && week ? descLine : null}'), 'in the first week the row comes first, then what it is');
  assert.doesNotMatch(CARD_SRC, /HeroActivity|HeroPulse/, 'who is around is one row');
  // The people, Invite and the ⋯ lead the row; Join is across from them at
  // its far end. "Make it public" and Leave are the ⋯'s now (#4045), and
  // Open app gives way to the First version card while it shows.
  assert.match(CARD_SRC, /const appButton = data\.first_version \? null : openApp;/);
  const row = CARD_SRC.slice(CARD_SRC.indexOf('<div className="dev-ws-hero-row">'), CARD_SRC.indexOf('{data.description && week ? descLine : null}'));
  assert.doesNotMatch(row, /<MakePublic|data-ws-community-leave/);
  // How a change gets in is the last line of the Workshop's Overview card now.
  assert.doesNotMatch(hero, /data-ws-community-rule/);
  // After-Workshop-B: one line, the whole rule in one sentence its tooltip.
  assert.match(CARD_SRC, /export function ApprovalLine\([\s\S]*?<p className="dev-ws-ov-rule" data-ws-approval-rules="" title=\{approvalLine\(data\.approval, data\)\}>[\s\S]*?<span className="dev-ws-ov-rule-text" data-ws-community-rule="">/);
  assert.doesNotMatch(read(HUB), /export function MembersCard/, 'the hub has no Members & activity card any more');
});

test('the hub draws no charts: who is around is faces, a count and names, and nothing on the hub is a dashboard', () => {
  const { HeroActive } = loadTsx(CARD);
  const counts = [0, 1, 2, 0, 0, 3, 4, 0, 1, 0, 0, 2, 0, 4];
  const five = ['evan', 'talha', 'zura', 'scraido2', 'kempis'].map((u, i) => ({ id: i + 1, username: u }));
  const active = (activity) => renderToHtml(createElement(HeroActive, { activity }));
  // A fortnight of activity is in the record, and the row still ends on the
  // names: no bars, no tip, no trend hook.
  const html = active({ active_week: 40, daily: days(counts), active_people: five });
  assert.match(html, /<span class="dev-ws-hero-active-names" data-ws-active-names="">evan, talha, zura, scraido2, kempis and 35 more<\/span><\/span><\/div>$/,
    'the faces, the count and the names, and nothing after them');
  assert.doesNotMatch(html, /data-ws-members-trend|role="img"|spark|trend/);
  // A zero says nothing: a quiet week is no row, whatever came before it.
  assert.equal(active({ active_week: 0, daily: days(counts), active_people: [] }), '');
  // No chart code is left for the hero or the hub, and none of its styles
  // or words: How it's going and the hero's sparkline are both gone.
  assert.doesNotMatch(CARD_SRC, /function Spark|sparkTip|sparkDay|TIP_LINGER_MS|data-ws-members-trend/);
  assert.doesNotMatch(read(HUB), /GoingCard|TrendBars|data-ws-hub-going|data-ws-members-trend|hub\.going\./);
  assert.doesNotMatch(LANDER, /<GoingCard/);
  assert.doesNotMatch(CSS, /\.dev-ws-hero-spark|\.dev-ws-going|\.dev-ws-trend|\.dev-ws-stat-(?:n|label|sub|figure|words)/);
  for (const id of ['project:communityCard.spark.caption', 'project:communityCard.spark.tip_other', 'project:hub.going.title']) {
    assert.throws(() => message(id), undefined, `${id} is gone from the catalog`);
  }
  // The declared check that read the trend reads who is around instead.
  // (#4729 removed three checks above it, so its index moved 290 → 288.)
  const declared = JSON.parse(read('dapp.json')).tests[288];
  assert.match(declared.expectSelector, /:has\(\.dev-ws-hero \[data-ws-active-people\]\) > \.dev-ws-tabbody > \[data-ws-hub-for-you\] > \.dev-ws-foryou > \[data-ws-hub-needs-votes\] > button\[data-ws-hub-needs-open\]$/);
  assert.equal(declared.expectText, 'to vote');
});

test('#4045: the first week\'s people row is the lock over "N people", or your face between open seats', () => {
  const { WeekPeople, WEEK_FACES } = loadTsx(CARD);
  const members = ['ada', 'lin', 'kai', 'mia'].map((u, i) => ({ id: i + 1, username: u }));
  const three = renderToHtml(createElement(WeekPeople, { members, count: 4, audience: 'invited', audienceLabel: 'Private community' }));
  assert.equal(WEEK_FACES, 3);
  assert.equal([...three.matchAll(/class="dev-ws-hero-face"/g)].length, 3, 'three faces, then the count says the rest');
  assert.match(three, /data-ws-community-audience=""><svg[^>]*>[\s\S]*?<\/svg><b>Private community<\/b><\/span><span class="dev-ws-hero-week-count">4 people<\/span>/,
    'the audience with its glyph, "4 people" under it');
  assert.doesNotMatch(three, /\d+ members/);
  // A public community says so the same way.
  const open = renderToHtml(createElement(WeekPeople, { members, count: 12, audience: 'open', audienceLabel: 'Public community' }));
  assert.match(open, /<b>Public community<\/b><\/span><span class="dev-ws-hero-week-count">12 people<\/span>/);
  // Just you: the label alone, no faces and no count.
  const solo = renderToHtml(createElement(WeekPeople, { members: [members[0]], count: 1, audience: 'solo', audienceLabel: 'Just you' }));
  assert.match(solo, /<b>Just you<\/b><\/span><\/span>/);
  assert.doesNotMatch(solo, /dev-ws-hero-face|\d+ (people|person)/);
  // An invite link is out: your face between two open seats, and the audience
  // it is about to be, with no count of one.
  const seats = renderToHtml(createElement(WeekPeople, { members: [members[0]], count: 1, audience: 'solo', audienceLabel: 'Just you', seats: true }));
  assert.match(seats, /data-ws-seats=""/);
  assert.match(seats, /<span class="dev-ws-hero-faces dev-ws-hero-seats" aria-hidden="true"><span class="dev-ws-hero-face dev-ws-hero-seat"[^>]*><svg[\s\S]*?<\/svg><\/span><span class="dev-ws-hero-face"[^>]*>A<\/span><span class="dev-ws-hero-face dev-ws-hero-seat"/,
    'a seat, you, a seat');
  assert.match(seats, /<b>Private community<\/b>/);
  assert.doesNotMatch(seats, /Just you|\d+ (people|person)|dev-ws-hero-week-count/);
  // The seats are the link's: only a member of a Just you project with one out.
  assert.match(CARD_SRC, /const seats = member && solo && !!data\.invite_link;/);
  assert.match(CSS, /\.dev-ws-hero-row > \.dev-ws-hero-week-people \+ \.dev-ws-hero-actions \{ flex: none;/);
});

test('#4896: a new project of one says "Just you so far" with Invite beside it, in the first week\'s row', async () => {
  // Onboarding run, 12 Oct 2026: right after the made screen said "Your new
  // community", the project page said "Just you", with Open app and the ⋯
  // beside it and the way to invite anyone at the foot of the hub.
  const { CommunityCard, reloadCommunity } = loadTsx(CARD);
  const record = (over = {}) => community({
    slug: 'garden-week', first_week: true, audience: 'solo', audience_label: 'Just you', member_count: 1,
    is_creator: true, members: [{ id: 1, username: 'ada' }], activity: null, ...over,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const slug = String(url).match(/\/api\/apps\/([^/]+)\/community/)[1];
    return { ok: true, json: async () => (slug === 'garden-week-link' ? record({ slug, invite_link: true }) : record({ slug })) };
  };
  try {
    await reloadCommunity('garden-week');
    await reloadCommunity('garden-week-link');
    const menu = createElement('span', { className: 'dev-ws-plus' }, createElement('button', { id: 'dev-plus-btn' }));
    const html = renderToHtml(createElement(CommunityCard, { slug: 'garden-week', name: 'Garden', menu, canOpenApp: true }));
    assert.match(html, /<div class="dev-ws-hero-row"><div class="dev-ws-hero-week-people" data-ws-members=""><span class="dev-ws-hero-week-who" data-ws-members-cell="members"><span class="dev-ws-hero-audience" data-ws-community-audience=""><svg[^>]*>[\s\S]*?<\/svg><b>Just you so far<\/b><\/span><\/span><\/div><div class="dev-ws-hero-actions"><button[^>]*data-ws-community-open-app=""[\s\S]*?<\/button><button[^>]*data-ws-community-invite=""[^>]*>Invite<\/button><span class="dev-ws-plus">/,
      '"Just you so far", then Open app, Invite and the ⋯, in one row');
    assert.doesNotMatch(html, /<b>Just you<\/b>/);
    // A link is out: the seats say what it is about to be, and Invite stays.
    const link = renderToHtml(createElement(CommunityCard, { slug: 'garden-week-link', name: 'Garden', menu }));
    assert.match(link, /data-ws-seats=""[\s\S]*<b>Private community<\/b>[\s\S]*data-ws-community-invite=""/);
    assert.doesNotMatch(link, /Just you/);
  } finally {
    globalThis.fetch = realFetch;
  }
  // Invite is the same button and the same pane a community's hero opens.
  assert.match(CARD_SRC, /data-ws-community-invite=""\s+title=\{t\('project:communityCard\.invite\.title'\)\}\s+onClick=\{openInviteLinks\}/);
});

test('#3276: the hero\'s rows wrap instead of running past a phone\'s edge', () => {
  // Five faces, "13 members", Joined and Invite came to 364px in a 359px
  // row on a 375px phone, and the hub scrolled sideways. Nothing in a row
  // can shrink, so it has to wrap: the people row, and the actions among
  // themselves, with Join or Joined held at the actions row's far end.
  const rule = (sel) => {
    const m = CSS.match(new RegExp(`^${sel.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`, 'm'));
    assert.ok(m, `${sel} has a rule`);
    return m[1];
  };
  assert.match(rule('.dev-ws-hero-people'), /display: flex; flex-wrap: wrap;/);
  assert.match(rule('.dev-ws-hero-row > .dev-ws-hero-actions'), /min-width: 0; flex-wrap: wrap;/);
  assert.match(rule('.dev-ws-hero-member'), /margin-left: auto; flex: none;/);
  // The Join popup hangs from the right of its button, which ends the row.
  assert.match(CSS, /\.dev-ws-hero \.dev-ws-hero-member \.dev-ws-join-pop \{ left: auto; right: -6px; \}/);
  // THE HUB'S HEAD stacks on a phone: name, description, who is around, then
  // the actions. From 768px the actions sit across from the name, packed
  // into the hole beside it, and the ⋯'s menu opens leftward into the column.
  assert.match(CSS, /@media \(min-width: 768px\) \{\s*\.dev-ws-hero-summary \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-auto-flow: row dense;/);
  assert.match(CSS, /\.dev-ws-hero-summary > \* \{ grid-column: 1 \/ -1; \}\s*\.dev-ws-hero-summary > \.dev-ws-hero-id \{ grid-column: 1; \}\s*\.dev-ws-hero-summary > \.dev-ws-hero-row \{ grid-column: 2; align-self: center; \}\s*\.dev-ws-hero-summary #dev-plus-menu \{ left: auto; right: 0; \}/);
  assert.ok(CSS.indexOf('.dev-ws-hero-summary #dev-plus-menu') > CSS.indexOf('.dev-ws-hero #dev-plus-menu { left: 0; right: auto; }'),
    'after the phone\'s rule, so it wins on a wide window');
  // Who is around keeps its names to one line, cut short on a narrow phone.
  assert.match(rule('.dev-ws-hero-active'), /display: flex; align-items: center; gap: 12px; min-width: 0;/);
  assert.match(CSS, /\.dev-ws-hero-active-names \{\s*font-size: 13px; line-height: 18px; color: var\(--text-muted\);\s*overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(rule('.dev-ws-hero-name'), /overflow-wrap: anywhere;/, 'a long name wraps rather than widening the page');
});

test('For you: Needs you counts the votes you owe, not the requests nobody has claimed', () => {
  const { ForYouCard, NothingToVote, owesVote } = loadTsx(HUB);
  const row = (key, title, kind) => ({ t: 'card', key, card: { title: { text: title } }, who: 'ada', kind });
  const card = (queue, over = {}) => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', name: 'Garden', queue, mine: null, workEmpty: 'plain', alone: false,
    data: community(), canPost: true, onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, ...over,
  }));
  const mixed = card([row('c1', 'Fix login', 'claim'), row('v1', 'Dark mode', 'vote'), row('c2', 'Tags', 'claim')]);
  assert.match(mixed, /data-ws-hub-needs-votes="1"/);
  assert.match(mixed, /<span class="dev-ws-foryou-pill">1 to vote<\/span>/);
  assert.match(mixed, /<span data-ws-hub-needs-first="">Dark mode<\/span>/, 'the first VOTE leads, not the first row');
  assert.doesNotMatch(mixed, /Fix login/);
  // #3408: requests owe no vote, so the hub draws no Needs you row, only
  // the line, and its count of requests (the view model's open unclaimed
  // count, now that the queue is votes alone) is the way to them.
  const claims = [row('c1', 'Fix login', 'claim'), row('c2', 'Tags', 'claim')];
  assert.equal(owesVote(claims), false, 'requests alone owe no vote');
  assert.equal(owesVote([...claims, row('v1', 'Dark mode', 'vote')]), true);
  const claimsOnly = renderToHtml(createElement(NothingToVote, { unclaimed: 2, onOpen: () => {} }));
  assert.match(claimsOnly, /^<p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on · <button type="button" class="dev-ws-link un-touch-target" data-ws-hub-needs-requests="">2 requests nobody has picked up<\/button><\/p>$/);
  assert.doesNotMatch(claimsOnly, /dev-ws-foryou-pill|Needs you/, 'no row, no count');
  const one = renderToHtml(createElement(NothingToVote, { unclaimed: 1, onOpen: () => {} }));
  assert.match(one, />1 request nobody has picked up</);
  assert.match(renderToHtml(createElement(NothingToVote, { unclaimed: 0, onOpen: () => {} })), />Nothing more to vote on\.</);
  // In the card, that line is the Needs you place's own, counted from
  // `unclaimed` and opening the Workshop, where the requests are.
  assert.match(card([], { unclaimed: 2 }), /<div class="dev-ws-strip dev-ws-foryou"><p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on · <button[^>]*data-ws-hub-needs-requests="">2 requests nobody has picked up</);
  assert.doesNotMatch(card(claims), /requests? nobody has picked up/, 'queue rows are not requests any more');
});

test('#3489: Your work stays on the hub with nothing in progress, and says so', () => {
  const { ForYouCard } = loadTsx(HUB);
  const card = (mine, workEmpty = 'plain') => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', name: 'Garden', queue: [], mine, workEmpty, alone: false,
    data: community(), canPost: true, onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {},
  }));
  const empty = card({ viewer: true, count: 0, shown: 3, rows: [] });
  assert.match(empty, /<button type="button" class="[^"]*dev-ws-foryou-row[^"]*" data-ws-mine-card="" data-ws-mine-open="workshop">/,
    'a door to the Workshop, where your work is listed in full');
  assert.match(empty, /<div class="[^"]*">Your work<\/div><div class="[^"]*"><span data-ws-mine-empty="">No work in progress\.<\/span><\/div>/);
  assert.doesNotMatch(empty, /dev-ws-foryou-count|in progress<\/span>/, 'no count of zero');
  // Only a signed-in viewer's hub draws it: a visitor has no work to list.
  // A project nobody else is in may leave it out (tests/hub-just-you.test.js).
  assert.doesNotMatch(card({ viewer: false, count: 0, shown: 3, rows: [] }), /data-ws-mine-card/);
  assert.doesNotMatch(card({ viewer: true, count: 0, shown: 3, rows: [] }, null), /data-ws-mine-card/);
  // With work: the first of it, and how many, in words.
  const work = (key, title, attrs = {}) => ({ t: 'card', key, card: { title: { text: title }, attrs } });
  const busy = card({ viewer: true, count: 2, shown: 3, rows: [work('mine:proposal:7', 'Add multi-language support across platform and apps'), work('mine:issue:9', 'Tags')] });
  assert.match(busy, /<span data-ws-mine-first="mine:proposal:7">Add multi-language support across platform and apps<\/span>/);
  assert.match(busy, /<span class="dev-ws-foryou-count">2 in progress<\/span>/);
  assert.doesNotMatch(busy, />Tags</, 'the rest are the Workshop\'s');
  assert.match(LANDER, /<ForYouCard\s+slug=\{slug\}\s+name=\{app\.name \|\| community\?\.name \|\| slug\}\s+queue=\{v\.queue\}\s+unclaimed=\{v\.dashboard \? v\.dashboard\.unclaimed : 0\}\s+mine=\{v\.mine\}\s+workEmpty=\{workEmpty\}\s+alone=\{alone \|\| weekOne\}\s+data=\{community\}\s+canPost=\{canPost\}\s+onNeeds=\{\(\) => openTab\('needs'\)\}\s+onWork=\{\(\) => openTab\('workshop'\)\}\s+onDiscussion=\{\(\) => openTab\('discussion'\)\}\s+\/>/);
});

test('the hub\'s channel record names each room\'s own write route, which the Discussion reads', () => {
  // The hub's composer is gone with its channel card; the record still names
  // where a message goes, and the Discussion place reads it to say whether it
  // can be written in.
  assert.doesNotMatch(read(HUB), /function HubComposer|data-ws-channel-compose/, 'no composer on the hub');
  assert.match(read('frontend/src/features/dev-board/workshop/project-discussion.tsx'), /const readOnly = !channel\?\.post_url;/);
  const route = read('src/routes/apps.js');
  assert.match(route, /post_url: `\/api\/conversations\/\$\{conversationId\}\/messages`,/);
  assert.match(route, /post_url: `\/api\/apps\/\$\{encodeURIComponent\(app\.slug\)\}\/messages`,/);
});

test('#4457, After-Workshop-B: the approval rule is one line: its checks pass, and who says yes, by name where there are names', () => {
  const { approvalStep, ruleSentence, RuleWords, ApprovalLine } = loadTsx(CARD);
  const member = { audience: 'invited', is_member: true };
  // Each regime is one whole sentence, in two wordings: the wide card's, and
  // the narrow card's without "A change".
  const say = (approval, viewer, approvers) => {
    const r = ruleSentence({ approvals_required: null, ...approval }, viewer, approvers);
    const long = message(r.long, r.values);
    assert.equal(message(r.short, r.values), long.replace(/^A change goes live/, 'Goes live'), `${r.long}: the short wording is the long one less "A change"`);
    return [long, r.names];
  };
  const L = 'A change goes live when its checks pass and ';
  // Invited approvers, named where either one or all of them is what it
  // takes and the names are the whole electorate (at most three of them).
  assert.deepEqual(say({ policy: 'invited', electorate: 2, required: 1 }, member, ['evan', 'snait']),
    [`${L}<0></0><1>evan or snait</1> says yes.`, ['evan', 'snait']]);
  assert.deepEqual(say({ policy: 'invited', electorate: 2, required: 2 }, member, ['evan', 'snait']),
    [`${L}<0></0><1>evan and snait</1> say yes.`, ['evan', 'snait']]);
  assert.deepEqual(say({ policy: 'invited', electorate: 1, required: 1 }, member, ['evan']), [`${L}<0></0><1>evan</1> says yes.`, ['evan']]);
  // Otherwise counted, as the steps counted them.
  assert.deepEqual(say({ policy: 'invited', electorate: 5, required: 1 }, member, ['a', 'b', 'c', 'd', 'e']),
    [`${L}1 of the 5 approvers says yes.`, null], 'past three names, a count');
  assert.deepEqual(say({ policy: 'invited', electorate: 3, required: 2 }, member, ['a', 'b', 'c']),
    [`${L}2 of the 3 approvers say yes.`, null], 'some of the named is a count, not a list');
  assert.deepEqual(say({ policy: 'invited', electorate: 2, required: 1 }, member, null), [`${L}1 of the 2 approvers says yes.`, null],
    'and a viewer the approvers route refuses reads the count');
  assert.deepEqual(say({ policy: 'invited', electorate: 1, required: 1 }, member, null), [`${L}the approver says yes.`, null]);
  assert.deepEqual(say({ policy: 'invited', electorate: 2, required: 2 }, member, null), [`${L}both approvers say yes.`, null]);
  assert.deepEqual(say({ policy: 'invited', electorate: 4, required: 4 }, member, null), [`${L}all 4 approvers say yes.`, null]);
  assert.deepEqual(say({ policy: 'invited', electorate: 2, required: 3 }, member, null), [`${L}3 approvers (there are 2) say yes.`, null]);
  // Members vote: the eased threshold; the wait rule is approvalStep's line.
  const open = { audience: 'open', is_member: true };
  assert.deepEqual(say({ policy: 'anyone', electorate: 12, required: 2 }, open, null), [`${L}2 of the 12 active members approve it.`, null]);
  assert.equal(approvalStep({ policy: 'anyone', approvals_required: null, electorate: 12, required: 2 }, open, null).wait,
    'Or after a wait, if one approves and nobody objects');
  assert.deepEqual(say({ policy: 'anyone', electorate: 12, required: 1 }, open, null), [`${L}1 of the 12 active members approves it.`, null]);
  assert.deepEqual(say({ policy: 'anyone', electorate: 2, required: 3 }, open, null), [`${L}3 active members (there are 2) approve it.`, null]);
  assert.deepEqual(say({ policy: 'anyone', electorate: 1, required: 1 }, open, null), [`${L}the only active member approves it.`, null]);
  assert.deepEqual(say({ policy: 'anyone', electorate: 2, required: 2 }, open, null), [`${L}both active members approve it.`, null]);
  assert.deepEqual(say({ policy: 'anyone', electorate: 3, required: 3 }, open, null), [`${L}all 3 active members approve it.`, null]);
  // At least N: no clock, so no wait line.
  assert.deepEqual(say({ policy: 'anyone', approvals_required: 3, electorate: 9, required: 3 }, member, null), [`${L}3 members approve it.`, null]);
  assert.equal(approvalStep({ policy: 'anyone', approvals_required: 3, electorate: 9, required: 3 }, member, null).wait, '');
  // A project that is just you.
  assert.deepEqual(say({ policy: 'anyone', electorate: 1, required: 1 }, { audience: 'solo', is_member: true }, null), [`${L}you approve it.`, null]);
  // The names' faces lead them, then the names in bold, in both wordings.
  const words = renderToHtml(createElement(RuleWords, { line: ruleSentence({ policy: 'invited', approvals_required: null, electorate: 2, required: 1 }, member, ['evan', 'snait']) }));
  assert.match(words, /^<span class="dev-ws-ov-wide">A change goes live when its checks pass and <span class="dev-ws-ov-faces" aria-hidden="true"><span class="dev-ws-ov-face" style="background:[^"]+">E<\/span><span class="dev-ws-ov-face" style="background:[^"]+">S<\/span><\/span><b class="dev-ws-ov-names">evan or snait<\/b> says yes\.<\/span><span class="dev-ws-ov-narrow">Goes live when its checks pass and <span class="dev-ws-ov-faces"/);
  assert.match(CARD_SRC, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/approvers`\)/, 'the approvers come from their own route');
  assert.match(CARD_SRC.slice(CARD_SRC.indexOf('export function ApprovalLine(')), /const approvers = useApprovers\(slug, invited\);/);
  assert.equal(typeof ApprovalLine, 'function');
  // The three steps went: no step tiles, no joins, no faces' step.
  assert.doesNotMatch(CARD_SRC, /dev-ws-rule-step|dev-ws-rule-join|data-ws-rule-people|export function ApprovalRules/);
});

test('#4527: the approval rule\'s line carries Rules, for exactly whom the rule lets propose', async () => {
  const { ApprovalLine, reloadCommunity } = loadTsx(CARD);
  const payload = (over = {}) => ({
    slug: 'rules-card', name: 'Rules', member_count: 11, is_member: true, is_creator: true,
    audience: 'open', audience_label: 'Public community',
    members: [1, 2, 3].map((i) => ({ id: i, username: `u${i}` })),
    channel: null,
    approval: { policy: 'anyone', approvals_required: null, electorate: 11, required: 4 },
    ...over,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const slug = String(url).match(/\/api\/apps\/([^/]+)\/community/)[1];
    return {
      ok: true,
      json: async () => payload({ slug, ...(slug === 'rules-manager' ? { can_manage: true } : {}) }),
    };
  };
  try {
    await reloadCommunity('rules-manager');
    await reloadCommunity('rules-viewer');
    // A manager sees Rules at the line's end, drawn like "See all"; the
    // line is the rule in words, the wait rule after it, the whole rule in
    // one sentence its tooltip.
    const managed = renderToHtml(createElement(ApprovalLine, { slug: 'rules-manager' }));
    assert.match(managed, /^<p class="dev-ws-ov-rule" data-ws-approval-rules="" title="A change goes live when 4 of the 11 active members approve it, or after a wait if one approves and nobody objects\."><svg class="dev-ws-ov-rule-icon"[^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="dev-ws-ov-rule-text" data-ws-community-rule=""><span class="dev-ws-ov-wide">A change goes live when its checks pass and 4 of the 11 active members approve it\.<\/span><span class="dev-ws-ov-narrow">Goes live when its checks pass and 4 of the 11 active members approve it\.<\/span><span class="dev-ws-ov-rule-wait">Or after a wait, if one approves and nobody objects<\/span><\/span><button type="button" class="dev-ws-hub-open dev-ws-ov-rule-edit un-touch-target" data-ws-rules-edit="" aria-label="Edit approval rules">Rules<\/button><\/p>$/);
    // Everyone else sees the line alone, with no button.
    const viewer = renderToHtml(createElement(ApprovalLine, { slug: 'rules-viewer' }));
    assert.doesNotMatch(viewer, /data-ws-rules-edit/);
    assert.match(viewer, /data-ws-community-rule="">/);
    // #4666: the click opens the Who can see & change it sheet, where the
    // rule is proposed alongside who can see the project.
    const src = CARD_SRC.slice(CARD_SRC.indexOf('export function ApprovalLine('));
    assert.match(src, /window\.UsernodeReact\?\.dialogs\?\.whoDecides\?\.open\(\{ slug \}\)/);
    assert.equal(message('project:communityCard.rule.rules'), 'Rules');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a person who has not joined reads the same What happened, its rows and Mark all seen', () => {
  // "Recently" over the rows for a visitor, and "Since your last visit" for
  // a member, went with the since list: the part is What happened for
  // everyone, and only its rows depend on the visitor's last visit.
  assert.doesNotMatch(LANDER, /outsider|project:since\.title\./);
  assert.match(LANDER, /<SectionHeader className="px-1\.5 pb-0 pt-3\.5" data-ws-part="happened">\{t\('project:workshop\.part\.happened'\)\}<\/SectionHeader>/);
  assert.equal(message('project:workshop.part.happened'), 'What happened');
  // The rows and Mark all seen are the same for everyone (declared checks
  // select on it on Homeroom's page).
  assert.match(LANDER, /\{v\.since \? \(\s*<button\s+type="button"\s+className="dev-ws-since-clear un-touch-target"\s+data-ws-since-clear=""/);
});

test('Make it public stays on Share it; who can see a project otherwise is the Who can see & change it sheet, from the ⋯ (#4666)', () => {
  const { audienceChangeLine, canLeave, MAKE_PUBLIC_LINE } = loadTsx(CARD);
  assert.equal(audienceChangeLine('Make this app public'), 'Making it a public community is waiting for approval');
  assert.equal(audienceChangeLine('Make this app private (collaborators only)'), 'Making it a private community is waiting for approval');
  assert.equal(audienceChangeLine('Make this app invite-only build, public to view'), 'A change to who it is for is waiting for approval');
  assert.equal(audienceChangeLine(null), 'A change to who it is for is waiting for approval');

  // Share it's popup still proposes it, through the visibility PR.
  const propose = CARD_SRC.slice(CARD_SRC.indexOf('export async function proposeAudience('), CARD_SRC.indexOf('export const MAKE_PUBLIC_LINE'));
  assert.match(propose, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/visibility-pr`/);
  assert.match(propose, /if \(!res\.ok && res\.status !== 409\)/, 'one already up is not an error: the hero shows it');

  // MAKE IT PUBLIC (it was "Open it up"): a button on a just-yours project's
  // Share it card, asking under itself.
  const pub = CARD_SRC.slice(CARD_SRC.indexOf('function MakePublic('), CARD_SRC.indexOf('export function InviteCard('));
  assert.match(pub, />\s*\{t\('project:communityCard\.share\.makePublic'\)\}\s*</);
  assert.equal(message('project:communityCard.share.makePublic'), 'Make it public');
  assert.match(pub, /const proposed = await proposeAudience\(slug, 'public'\);/);
  assert.match(pub, /<p className="dev-ws-vote-sub">\{t\(MAKE_PUBLIC_LINE\)\}<\/p>/);
  assert.equal(MAKE_PUBLIC_LINE, 'project:communityCard.makePublic.explain');
  assert.equal(message(MAKE_PUBLIC_LINE), 'Anyone can find it on Discover, join, and propose changes. '
    + 'Members vote on this first, and it applies once it merges.', 'it says it is a proposal, not a switch');
  const hero = CARD_SRC.slice(CARD_SRC.indexOf('export function CommunityCard('), CARD_SRC.indexOf('export function shareItLine('));
  assert.doesNotMatch(hero, /<MakePublic /, 'not a button in the hero');
  assert.match(CARD_SRC, /\{canOpenUp \? \(\s*<MakePublic /);

  // The ⋯'s Make it public and Make it private rows are one row now.
  assert.doesNotMatch(CARD_SRC, /export (async )?function (confirmMakePrivate|confirmMakePublic|canMakePrivate|canMakePublic)\(/);
  const menu = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.doesNotMatch(menu, /data-plus="make-(public|private)"/);
  assert.match(menu, /\{onWhoDecides \? \(\s*<PlusRow\s+data-plus="who-decides"[\s\S]{0,140}title=\{t\('project:menu\.whoDecides\.title'\)\}\s+sub=\{t\('project:menu\.whoDecides\.sub'\)\}[\s\S]{0,300}onClick=\{\(\) => \{ callAppView\('_closePlusMenu'\); onWhoDecides\(\); \}\}/);
  assert.equal(message('project:menu.whoDecides.title'), 'Who can see & change it');
  assert.ok(menu.indexOf('data-plus="who-decides"') > menu.indexOf('id="dev-plus-settings"'), 'in the Settings & rules panel');

  // LEAVE (#4045): the Joined pill's way out, as a row of the ⋯, for a
  // member who did not start it.
  assert.equal(canLeave({ is_member: true, is_creator: false }), true);
  assert.equal(canLeave({ is_member: true, is_creator: true }), false);
  assert.equal(canLeave({ is_member: false, is_creator: false }), false);
  assert.equal(canLeave(null), false);
  assert.match(menu, /\{onLeave \? \(\s*<PlusRow\s+data-plus="leave"[\s\S]{0,140}title=\{appName \? t\('project:menu\.leave\.named', \{ project: appName \}\) : t\('project:menu\.leave\.plain'\)\}[\s\S]{0,200}onClick=\{\(\) => \{ callAppView\('_closePlusMenu'\); onLeave\(\); \}\}/);
  assert.ok(menu.indexOf('data-plus="leave"') > menu.indexOf('data-plus="who-decides"'), 'Leave follows it');

  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(lander, /onWhoDecides=\{community\?\.can_manage\s*\? \(\) => \{ window\.UsernodeReact\?\.dialogs\?\.whoDecides\?\.open\(\{ slug \}\); \}\s*: null\}/);
  assert.match(lander, /onLeave=\{canLeave\(community\) \? \(\) => \{ void leaveCommunity\(slug\); \} : null\}/);
  // The row appears once the read answers, after the menu was wired, so it
  // closes the menu through the close the wiring publishes.
  assert.match(read('public/js/app-view.js'), /AppView\._closePlusMenu = close;/);
  assert.match(CARD_SRC, /href=\{changeHref\(slug, data\.audience_change\.session_id, data\.audience_change\.pr_number\)\}/);
  // The server offers it to exactly whom the proposal routes accept.
  const route = read('src/routes/apps.js');
  assert.match(route, /const canManage = !app\.self_hosted && !!app\.repo_url\s*&& await appAdmins\.canManageApp\(pool, app, req\.user\);/);
  assert.match(route, /await renamePr\.findVisibilityPr\(pool, app\.id\)/);
});

test('a Mayor card refused for membership offers Join, then asks the Mayor to try again', () => {
  const tools = require('../src/services/mcp-tools');
  const refused = tools.platformError({ ok: false, status: 403, body: { code: 'join_required', error: 'Join Garden to take part.', app: { slug: 'garden', name: 'Garden' } } });
  assert.equal(refused.structuredContent.code, 'join_required');

  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  const action = (status, result) => ({ id: 'a1', toolName: 'start_change', title: 'Start a change', status, result, expiresAt: '2099-01-01T00:00:00Z' });
  const failed = action('failed', { ok: false, code: 'join_required', structured: { code: 'join_required', message: 'Join Garden to take part.', app: { slug: 'garden', name: 'Garden' } }, text: '' });
  assert.deepEqual(transcript.joinFor(failed), { slug: 'garden', name: 'Garden' });
  const card = { id: 'a1', toolName: 'start_change', title: 'Start a change', input: {}, expiresAt: '2099-01-01T00:00:00Z' };
  assert.deepEqual(transcript.cardView(card, new Map([['a1', failed]])).join, { slug: 'garden', name: 'Garden' });
  assert.equal(transcript.joinFor(action('failed', { ok: false, code: 'no_access', structured: { code: 'no_access' } })), null);
  assert.equal(transcript.cardView(card, new Map([['a1', action('done', failed.result)]])).join, null, 'only a failed card asks');

  const screen = read('frontend/src/features/agent-session/index.tsx');
  const join = screen.slice(screen.indexOf('function JoinToRetry('), screen.indexOf('function Card('));
  assert.match(join, /home\.setMembership\(join\.slug, true, undefined, \{ name: join\.name \}\)/, 'the one join path');
  assert.match(join, /void sendAgentMessage\(t\('agent:session\.join\.joinedMessage', \{ community: join\.name, action: card\.title \}\)\);/);
  assert.equal(message('agent:session.join.joinedMessage', { community: 'Notes', action: 'File a request' }),
    'I joined Notes. Please try "File a request" again.');
  assert.match(screen, /\{card\.status === 'failed' && card\.join \? \(\s*<JoinToRetry card=\{card\} join=\{card\.join\} \/>/);
  // No prose from the Mayor under the Join button: the card asks.
  const routes = read('src/routes/agent-sessions.js');
  assert.match(routes, /const joinRequired = outcome && outcome\.result && outcome\.result\.code === 'join_required';\s*const followUp = joinRequired \? null : await startFollowUp\(/);
});

test('a Homeroom line kept in #general, as the root of somebody\'s thread, is drawn as Homeroom\'s', () => {
  const conv = read('src/services/conversations.js');
  assert.match(conv, /username: system \? 'Homeroom' : \(row\.sender_username \|\| 'Deleted user'\),/);
  assert.match(conv.slice(conv.indexOf('async function countUnread(')), /AND m\.msg_type = 'message'/);
  const rows = read('frontend/src/features/messages/index.tsx');
  assert.match(rows, /&& !previous\.system && !message\.system/, 'an event never joins the row above it');
  assert.match(CSS, /\.messages-message-system \.messages-message-author \{ color: var\(--text-muted\); \}/);
});

test('Discover rows open the hub; the controls sit over the list\'s card', () => {
  const browse = read('frontend/src/features/apps/browse.js');
  assert.match(browse, /rowHref\(view\) \{\s*if \(!view \|\| view\.demo \|\| !view\.slug\) return null;\s*return `#app\/\$\{encodeURIComponent\(view\.slug\)\}\/workshop`;/);
  assert.match(read('public/js/app.js'), /return slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#communities';/,
    'the same address App._hubHref builds');
});

test('the Communities screen has no toggle: Needs you is a row that opens a page', () => {
  // It had two tabs, Current status and Needs you, drawn as the project
  // page's strip. The UI overhaul made the list the page and Needs you a
  // row at its top ("3 votes waiting on you"), which opens the feed with a
  // way back; the strip and its CSS went with the tabs.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.doesNotMatch(screen, /SECTION_TAB_ACTIVE|<TabsList|workshop-scope-tab/);
  assert.doesNotMatch(CSS, /\.workshop-scope-tabs? \{/);
  assert.match(screen, /<ListRow\s+as="button"\s+data-workshop-needs-open=""/);
  assert.match(screen, /className="dev-ws-page-back un-touch-target"\s+data-workshop-needs-back=""/,
    'the way back is the project page\'s own back disc');
});

test('Home\'s Browse all links carry the accent, not the header\'s periwinkle', () => {
  const ui = read('frontend/src/features/home/panels/ui.tsx');
  for (const cls of ['home-panel-browse', 'home-panel-lb-browse']) {
    const tag = ui.slice(ui.indexOf(`className="${cls} `), ui.indexOf('"', ui.indexOf(`className="${cls} `) + 12));
    assert.match(tag, /text-\[color:var\(--accent\)\]/, `${cls} is the accent`);
    assert.doesNotMatch(tag, /brand-ink/);
  }
});
