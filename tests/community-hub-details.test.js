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
    // Somebody outside it (an admin's look) is still deciding: the project
    // card (the hand-off of 11 Nov 2026), its people card reading the
    // audience's name, and no Invite: making a link is a member's.
    await reloadCommunity('garden-solo-outside');
    const outside = renderToHtml(createElement(CommunityCard, { slug: 'garden-solo-outside', name: 'Garden', menu }));
    assert.match(outside, /^<div class="dev-ws-project-card[^"]*" data-ws-community="" data-ws-project-card="" data-audience="solo">/);
    assert.match(outside, /data-ws-community-audience=""><svg[^>]*>[\s\S]*?<\/svg><b>Just you<\/b><\/span>/);
    assert.doesNotMatch(outside, /Just you so far|data-ws-community-invite/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const hero = CARD_SRC.slice(CARD_SRC.indexOf('export function CommunityCard('), CARD_SRC.indexOf('export function shareItLine('));
  // One hub from the first day (15 Oct 2026): what it is, its description,
  // who is around when anybody else is, then what you can do.
  assert.match(hero, /<HeroIdentity slug=\{slug\} name=\{displayName\} iconUrl=\{iconUrl\} iconEmoji=\{iconEmoji\} data=\{data\} member=\{member\} \/>\s*\{data\.description \? \(\s*<p className="dev-ws-hero-desc" data-ws-community-description="">\{data\.description\}<\/p>\s*\) : null\}/);
  assert.match(hero, /const others = !solo && \(Number\(data\.member_count\) \|\| 0\) > 1;/);
  assert.match(hero, /\{others \? <HeroActive activity=\{data\.activity\} \/> : null\}/);
  assert.match(hero, /className="dev-ws-hero dev-ws-hero-summary"/, 'the hub\'s head, always');
  assert.ok(hero.indexOf('<HeroActive') < hero.lastIndexOf('<div className="dev-ws-hero-row">'), 'then what you can do');
  assert.doesNotMatch(CARD_SRC, /HeroActivity|HeroPulse/, 'who is around is one row');
  // The people, Invite and the ⋯ lead the row; Join is across from them at
  // its far end. "Make it public" and Leave are the ⋯'s now (#4045), and
  // Open app gives way to the First version card while it shows.
  assert.match(CARD_SRC, /const appButton = data\.first_version \? null : openApp;/);
  const row = CARD_SRC.slice(CARD_SRC.indexOf('<div className="dev-ws-hero-row">'), CARD_SRC.indexOf('{data.audience_change ? ('));
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
  // (#4729 removed three checks above it, so its index moved 290 → 288;
  // #3969 added the Accessibility settings check above it, so it moved
  // 288 → 289; #5992 removed the two feedback destination checks above it,
  // so it moved 289 → 287; #6000 added the Propose reopening check above it,
  // so it moved 287 → 288; One Home, #6361, retired three Discover checks
  // above it, so it is found by what it reads now, not by its place.)
  const declared = JSON.parse(read('dapp.json')).tests
    .find((t) => (t.expectSelector || '').includes(':has(.dev-ws-hero [data-ws-active-people])'));
  assert.ok(declared, 'the check is declared');
  assert.match(declared.expectSelector, /:has\(\.dev-ws-hero \[data-ws-active-people\]\) > \.dev-ws-tabbody > \[data-ws-hub-for-you\] > \.dev-ws-foryou > \[data-ws-hub-needs-votes\] > button\[data-ws-hub-needs-open\]$/);
  assert.equal(declared.expectText, 'to vote');
});

test('one hub from the first day: a new project leads with its tile and name, and a link out is still "Just you so far" (15 Oct 2026)', async () => {
  // A project's first week had a hero of its own (#4045): no tile or name,
  // which the First version card was to draw, so a ready-made app's hub had
  // no name at all, and a link out read "Private community" between open
  // seats. Now every hub leads the same way, from its first day.
  const { CommunityCard, reloadCommunity } = loadTsx(CARD);
  const record = (over = {}) => community({
    slug: 'garden-new', audience: 'solo', audience_label: 'Just you', member_count: 1,
    description: 'Seeds, swaps and Sunday digs.', is_creator: true, members: [{ id: 1, username: 'ada' }],
    activity: { active_week: 1, shipped_month: 0, active_people: [{ id: 1, username: 'ada' }] }, first_version: null, ...over,
  });
  const records = {
    'garden-new': record(),
    'garden-new-link': record({
      slug: 'garden-new-link', invite_link: true,
      invite_summary: { links: 1, joined: 0, waiting: 0, expires_at: '2026-10-22T12:00:00.000Z' },
    }),
    'garden-new-group': record({
      slug: 'garden-new-group', audience: 'invited', audience_label: 'Private community', member_count: 3, is_creator: false,
      members: [{ id: 1, username: 'ada' }, { id: 2, username: 'lin' }, { id: 3, username: 'kai' }],
      activity: { active_week: 3, shipped_month: 0, active_people: [{ id: 1, username: 'ada' }, { id: 2, username: 'lin' }, { id: 3, username: 'kai' }] },
    }),
    'garden-new-alone': record({
      slug: 'garden-new-alone', audience: 'open', audience_label: 'Public community', member_count: 1,
    }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const slug = String(url).match(/\/api\/apps\/([^/]+)\/community/)[1];
    return { ok: true, json: async () => records[slug] };
  };
  try {
    for (const slug of Object.keys(records)) await reloadCommunity(slug);
    const menu = createElement('span', { className: 'dev-ws-plus' }, createElement('button', { id: 'dev-plus-btn' }));
    const draw = (slug) => renderToHtml(createElement(CommunityCard, { slug, name: 'Garden', iconEmoji: '🌱', menu, canOpenApp: true }));
    const fresh = draw('garden-new');
    assert.match(fresh, /^<section class="dev-ws-hero dev-ws-hero-summary" data-ws-community="" data-audience="solo">/,
      'the hub\'s head, as on every project');
    assert.match(fresh, /<div class="dev-ws-hero-id" data-ws-community-id=""><span class="app-icon-tile dev-ws-hero-tile" data-icon="emoji" aria-hidden="true">[\s\S]*?<h1 class="dev-ws-hero-name" data-ws-community-name="">Garden<\/h1><span class="dev-ws-hero-id-sub" data-ws-members-cell="members"><span class="dev-ws-hero-audience" data-ws-community-audience="">Just you so far<\/span><\/span><\/span><\/div><p class="dev-ws-hero-desc" data-ws-community-description="">Seeds, swaps and Sunday digs\.<\/p><div class="dev-ws-hero-row"><div class="dev-ws-hero-actions"><button[^>]*data-ws-community-open-app=""[\s\S]*?<\/button><button[^>]*data-ws-community-invite=""[^>]*>Invite<\/button><span class="dev-ws-plus">/,
      'its tile and name over "Just you so far", its description, then Open app, Invite and the ⋯');
    assert.doesNotMatch(fresh, /data-ws-active-people|dev-ws-hero-week|data-ws-seats/, 'nobody else to name, and no first week\'s row');
    // A link out does not make it a private community: somebody joining does.
    const link = draw('garden-new-link');
    assert.match(link, /data-ws-community-audience="">Just you so far<\/span>[\s\S]*data-ws-community-invite=""/);
    assert.doesNotMatch(link, /Private community|data-ws-seats|dev-ws-hero-seat/);
    // A group in its first week reads as any group does: who is around too.
    const group = draw('garden-new-group');
    assert.match(group, /data-ws-community-audience="">Private community<\/span> · 3 members<\/span>/);
    assert.match(group, /data-ws-active-people="3"/, 'who is around, with other people in it');
    // Nobody else in it yet: nobody else to name, whatever its audience.
    assert.doesNotMatch(draw('garden-new-alone'), /data-ws-active-people/);
  } finally {
    globalThis.fetch = realFetch;
  }
  // Invite is the same button and the same pane a community's hero opens.
  assert.match(CARD_SRC, /data-ws-community-invite=""\s+title=\{t\('project:communityCard\.invite\.title'\)\}\s+onClick=\{openInviteLinks\}/);
  assert.doesNotMatch(CARD_SRC, /first_week|WeekPeople|WEEK_FACES|const seats = |dev-ws-hero-week/, 'the first week\'s own hero is gone');
  assert.doesNotMatch(CSS, /dev-ws-hero-week|dev-ws-hero-seat/, 'and its styles with it');
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
  assert.match(rule('.dev-ws-hero-member'), /margin-inline-start: auto; flex: none;/);
  // The Join popup hangs from the right of its button, which ends the row.
  assert.match(CSS, /\.dev-ws-hero \.dev-ws-hero-member \.dev-ws-join-pop \{ inset-inline-start: auto; inset-inline-end: -6px; \}/);
  // THE HUB'S HEAD stacks on a phone: name, description, who is around, then
  // the actions. From 768px the actions sit across from the name, packed
  // into the hole beside it, and the ⋯'s menu opens leftward into the column.
  assert.match(CSS, /@media \(min-width: 768px\) \{\s*\.dev-ws-hero-summary \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-auto-flow: row dense;/);
  assert.match(CSS, /\.dev-ws-hero-summary > \* \{ grid-column: 1 \/ -1; \}\s*\.dev-ws-hero-summary > \.dev-ws-hero-id \{ grid-column: 1; \}\s*\.dev-ws-hero-summary > \.dev-ws-hero-row \{ grid-column: 2; align-self: center; \}\s*\.dev-ws-hero-summary #dev-plus-menu \{ inset-inline-start: auto; inset-inline-end: 0; \}/);
  assert.ok(CSS.indexOf('.dev-ws-hero-summary #dev-plus-menu') > CSS.indexOf('.dev-ws-hero #dev-plus-menu { inset-inline-start: 0; inset-inline-end: auto; }'),
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
    slug: 'garden', queue, mine: null, alone: false,
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

test('#6438, 6 Nov 2026: on a wide window For you draws the Workshop row, opening the project\'s Workshop, and no Your work row', () => {
  const { ForYouCard } = loadTsx(HUB);
  const card = (mine, over = {}) => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', queue: [], mine, alone: false,
    data: community(), canPost: true, onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, ...over,
  }));
  // No `places`: a wide window. 6 Nov 2026: For you's row is the Workshop's
  // (the phone's row until then), and it opens the project's Workshop, where
  // what happened and every item are. Your own work is the Workshop tab's
  // own card (your-work.tsx YourWorkCard), not a row here.
  const html = card({ viewer: true });
  const row = (html.match(/<button [^>]*data-ws-workshop-row=""[^>]*>/) || [''])[0];
  assert.ok(row, 'a button: it opens the Workshop on this page, not an address');
  assert.match(row, /class="[^"]*dev-ws-foryou-row[^"]*"/);
  assert.match(html, /<div class="[^"]*">Workshop<\/div>/);
  assert.match(html, /<div class="[^"]*">What happened, and every item<\/div>/);
  // It is the Workshop's row, wired to onWork, not the Homeroom bot tab's.
  assert.match(read(HUB), /\{work \? <WorkshopRow onOpen=\{onWork\} \/> : null\}/);
  assert.doesNotMatch(html, /data-ws-mine-card|#homeroom-bot\?project=/, 'no Your work row on the Hub, at any width');
  // Only a signed-in viewer's hub draws it: a visitor has no work to be
  // told about. A project nobody else is in draws it the same way, from its
  // first day (15 Oct 2026, tests/hub-just-you.test.js).
  assert.doesNotMatch(card({ viewer: false }), /data-ws-workshop-row/);
  assert.match(card({ viewer: true }, { alone: true, data: community({ audience: 'solo', member_count: 1 }) }), /data-ws-workshop-row/);
  assert.match(LANDER, /<ForYouCard\s+slug=\{slug\}\s+queue=\{v\.queue\}\s+unclaimed=\{v\.dashboard \? v\.dashboard\.unclaimed : 0\}\s+mine=\{v\.mine\}\s+alone=\{alone\}\s+data=\{community\}\s+canPost=\{canPost\}\s+onNeeds=\{\(\) => openTab\('needs'\)\}\s+onWork=\{\(\) => openTab\('workshop'\)\}\s+onDiscussion=\{\(\) => openTab\('discussion'\)\}\s+\/>/);
  assert.doesNotMatch(LANDER, /places=\{drawerOn\}/, 'For you needs no phone-only flag');
});

test('the Your work row counts in the Homeroom bot tab\'s own words, for the Workshop tab\'s card', () => {
  // The counts: the tab's own lists for this project, by the tab's own rules.
  const { deskOf, deskWords, deskLine } = loadTsx('frontend/src/features/ai/desk.ts');
  const app = { slug: 'garden', name: 'Garden' };
  const other = { slug: 'other', name: 'Other' };
  // Each row where its work state puts it (lib/work-state.ts).
  const thread = (id, work, group, a = app) => ({ threadId: id, number: id, kind: 'work', title: `T${id}`, app: a, change: null, href: `#app/${a.slug}/dev/issues/${id}`, group, work: { why: null, reason: null, line: null, since: null, ...work }, at: null });
  const d = deskOf('garden', [{ kind: 'proposal', id: 1, number: 40, title: 'Dark mode', app }], {
    private: [], needs: [thread(2, { stage: 'waiting_for_you', why: 'plan' }, 'needs')],
    next: [thread(3, { stage: 'building' }, 'next'), thread(4, { stage: 'building' }, 'next', other)],
    waiting: [thread(5, { stage: 'up_for_vote' }, 'waiting')], live: [],
  });
  assert.deepEqual([d.ready, d.needs, d.progress, d.waiting, d.first], [true, 2, 1, 1, 'Dark mode'], 'this project\'s share, the first thing owed first');
  assert.deepEqual(deskWords(d), { id: 'project:workshop.desk.both', values: { needs: 2, progress: 1 } });
  assert.deepEqual(deskLine(d), { id: 'project:workshop.desk.next', values: { title: 'Dark mode' } });
  const none = deskOf('garden', [], { private: [], needs: [], next: [], waiting: [], live: [] });
  assert.equal(deskWords(none), null, 'a zero says nothing');
  assert.deepEqual(deskLine(none), { id: 'project:workshop.desk.empty' });
  assert.equal(deskWords(deskOf('garden', null, null)), null, 'nothing read yet: nothing said');
  assert.equal(message('project:workshop.desk.empty'), 'Nothing of yours here right now.');
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
  // Polish board #13: the names come with the community record, so the line
  // is drawn once; only an older server's record, without them, asks their
  // own route.
  assert.match(CARD_SRC, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/approvers`\)/, 'the approvers\' own route, for an older server');
  const line = CARD_SRC.slice(CARD_SRC.indexOf('export function ApprovalLine('));
  assert.match(line, /const given = data && data\.approval \? data\.approval\.approvers : undefined;/);
  assert.match(line, /const approvers = given !== undefined \? given : asked;/);
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

test('Needs you has no toggle: it is a page of its own, the header its way back', () => {
  // It had two tabs, Current status and Needs you, drawn as the project
  // page's strip. The UI overhaul made the list the page and Needs you a
  // row at its top that opened the feed with a back disc; One Home (#6361)
  // gave the list to Home and left the feed as the page (#needs), whose way
  // back is the header's arrow up to Home.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.doesNotMatch(screen, /SECTION_TAB_ACTIVE|<TabsList|workshop-scope-tab/);
  assert.doesNotMatch(CSS, /\.workshop-scope-tabs? \{/);
  assert.doesNotMatch(screen, /data-workshop-needs-(?:open|back)=/, 'no door and no disc: the page is all feed');
  assert.match(read('public/js/app.js'), /'workshop-screen': \['arrow', '\/'\],/);
});

test('Home\'s See all links carry the accent, not the header\'s periwinkle', () => {
  const ui = read('frontend/src/features/home/panels/ui.tsx');
  // Browse all (`home-panel-browse`) went with Home's Discover lane (#6361).
  for (const cls of ['home-panel-see-all']) {
    const tag = ui.slice(ui.indexOf(`className="${cls} `), ui.indexOf('"', ui.indexOf(`className="${cls} `) + 12));
    assert.match(tag, /text-\[color:var\(--accent\)\]/, `${cls} is the accent`);
    assert.doesNotMatch(tag, /brand-ink/);
  }
});

// ── Still deciding: the project card (the hand-off of 11 Nov 2026) ───────

test('signed in but not in it: the hub leads with the project card, Open app, Join and the ⋯, and the people card under it', async () => {
  const { CommunityCard, reloadCommunity } = loadTsx(CARD);
  const five = ['evan', 'talha', 'zura', 'scraido2', 'kempis'].map((u, i) => ({ id: i + 1, username: u, display_name: null }));
  const record = (slug, member) => community({
    slug, name: 'Garden', is_member: member, member_count: 91, audience: 'open', audience_label: 'Public community',
    description: 'Seeds, swaps and Sunday digs.',
    cover: { illustration_url: '/app-illustrations/abc', illustration_dark_url: null, preview_url: '/app-previews/loop' },
    activity: { active_week: 34, shipped_month: 39, active_people: five },
  });
  const realFetch = globalThis.fetch;
  const over = new Map();
  globalThis.fetch = async (url) => {
    const slug = String(url).match(/\/api\/apps\/([^/]+)\/community/)[1];
    return { ok: true, json: async () => ({ ...record(slug, slug === 'garden-member'), ...(over.get(slug) || {}) }) };
  };
  const reloadCommunityAs = async (slug, extra) => { over.set(slug, extra); await reloadCommunity(slug); };
  try {
    await reloadCommunity('garden-outsider');
    await reloadCommunity('garden-member');
    const menu = (place) => createElement('span', { className: 'dev-ws-plus', 'data-place': place });
    const html = renderToHtml(createElement(CommunityCard, { slug: 'garden-outsider', name: 'Garden', canOpenApp: true, menu }));
    // (React's server render hoists a preload for the card's picture ahead of it.)
    assert.match(html, /^(?:<link rel="preload" as="image" href="\/app-illustrations\/abc"\/>)?<div class="dev-ws-project-card[^"]*" data-ws-community="" data-ws-project-card="" data-audience="open"><section data-project-card="hub"/);
    assert.match(html, /style="background:var\(--community-tint, #2a2e34\)"/, 'in the project\'s colour');
    // Its picture: the featured illustration, and no video in the first
    // render (the loop mounts after, where it may play).
    assert.match(html, /<img src="\/app-illustrations\/abc"/);
    assert.doesNotMatch(html, /<video/);
    assert.match(html, /<h1 data-project-card-name=""[^>]*>Garden<\/h1>/);
    assert.match(html, /data-project-card-description=""[^>]*>Seeds, swaps and Sunday digs\.</);
    // Open app, the same Join (popup and all), and the ⋯ drawn for the card.
    const actions = html.slice(html.indexOf('data-project-card-actions'));
    assert.ok(actions.indexOf('data-ws-community-open-app') < actions.indexOf('data-ws-community-join'));
    assert.ok(actions.indexOf('data-ws-community-join') < actions.indexOf('data-place="card"'));
    assert.match(html, /<button type="button" data-ws-community-join="" aria-haspopup="dialog" aria-expanded="false" class="rounded-full bg-violet-600 /);
    // Who is around, in its own card: the faces and names a signed-in
    // viewer reads on the hub, and who it is for.
    assert.match(html, /<div data-ws-people-card=""[^>]*>[\s\S]*data-ws-active-people="34"[\s\S]*data-ws-community-audience=""/);
    assert.doesNotMatch(html, /dev-ws-hero-id|data-ws-community-invite/, 'not the member\'s hero');
    // Zero says nothing: a project nobody is in yet says who it is for alone.
    await reloadCommunityAs('garden-empty', { member_count: 0, members: [], activity: null });
    const empty = renderToHtml(createElement(CommunityCard, { slug: 'garden-empty', name: 'Garden', canOpenApp: true, menu }));
    assert.match(empty, /<span class="dev-ws-hero-count" data-ws-members-cell="members"><span class="dev-ws-hero-audience" data-ws-community-audience=""><svg[^>]*>[\s\S]*?<\/svg><b>Public community<\/b><\/span><\/span>/);
    assert.doesNotMatch(empty, /0 members|data-ws-active-people/);
    // A member keeps the hub's own hero, the ⋯ drawn for it.
    const member = renderToHtml(createElement(CommunityCard, { slug: 'garden-member', name: 'Garden', canOpenApp: true, menu }));
    assert.match(member, /^<section class="dev-ws-hero dev-ws-hero-summary"/);
    assert.match(member, /data-place="hero"/);
    assert.doesNotMatch(member, /data-project-card/);
  } finally {
    globalThis.fetch = realFetch;
  }
  // The route sends the picture its group voted in (routes/apps.js).
  assert.match(read('src/routes/apps.js'), /preview_url: art\[0\]\.preview_id \? `\/app-previews\/\$\{art\[0\]\.preview_id\}` : null,/);
});

test('For you for somebody not in it: "Up for a vote · Join to vote on these." with a light count, and no unread pill', () => {
  const { ForYouCard } = loadTsx(HUB);
  const queue = Array.from({ length: 13 }, (_, i) => ({ kind: 'vote', t: 'card', key: `v${i}`, card: { title: { text: `Vote ${i}` } } }));
  const data = (member) => community({
    is_member: member, member_count: 91,
    channel: { last_message: 'Hello', last_at: new Date().toISOString(), last_by: 'mei215', unread_count: 5, handle: 'general', recent: [] },
  });
  const card = (member) => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', queue, unclaimed: 0, mine: { viewer: 1 }, alone: false, data: data(member), canPost: member,
    onNeeds() {}, onWork() {}, onDiscussion() {},
  }));
  const outside = card(false);
  assert.match(outside, /data-ws-hub-needs-votes="13" data-ws-hub-needs-outsider=""/);
  assert.ok(outside.includes(`>${message('project:hub.needs.upForVote')}<`));
  assert.match(outside, /<span data-ws-hub-needs-join="">Join to vote on these\.<\/span>/);
  assert.match(outside, /class="dev-ws-foryou-pill dev-ws-foryou-pill-light" data-ws-hub-needs-count=""><span aria-hidden="true">13<\/span><span class="sr-only">13 changes up for a vote<\/span>/);
  assert.doesNotMatch(outside, /to vote<\/span>|data-ws-channel-unread/);
  // A member's: Needs you, "13 to vote", and the room's unread count.
  const inside = card(true);
  assert.doesNotMatch(inside, /data-ws-hub-needs-outsider/);
  assert.match(inside, />13 to vote</);
  assert.match(inside, /data-ws-channel-unread="5"/);
  assert.match(CSS, /\.dev-ws-foryou-pill\.dev-ws-foryou-pill-light \{ background: color-mix\(in srgb, var\(--accent\) 12%, transparent\); color: var\(--accent\); \}/);
});

test('every hub\'s Recently live ends with how many more went live this month, opening the Workshop, and nothing at zero', () => {
  const { RecentlyLive } = loadTsx(HUB);
  const rows = [1, 2, 3].map((n) => ({ key: `r${n}`, sessionId: n, prNumber: n, title: `Change ${n}`, who: 'ada', at: new Date().toISOString(), going: false, picture: null }));
  let opened = 0;
  const live = (props) => renderToHtml(createElement(RecentlyLive, { slug: 'garden', rows, onAll() { opened++; }, ...props }));
  const html = live({ month: 39 });
  assert.match(html, /<button type="button" class="dev-ws-recent-more" data-ws-recent-more="36"><span class="dev-ws-recent-more-n" aria-hidden="true">\+36<\/span><span class="dev-ws-recent-more-words">36 more live this month<\/span>/);
  assert.ok(html.indexOf('</ul>') < html.indexOf('data-ws-recent-more'), 'under the pictures');
  assert.doesNotMatch(live({ month: 3 }), /data-ws-recent-more/, 'all of the month shown: nothing more to say');
  assert.doesNotMatch(live({}), /data-ws-recent-more/, 'an older server without the count');
  assert.doesNotMatch(live({ rows: [], own: { name: 'Garden', since: new Date().toISOString() }, month: 5 }), /data-ws-recent-more/, 'the app\'s own card stands alone');
  // The hub hands it the month's count, and the row opens the Workshop.
  assert.match(LANDER, /month=\{community\?\.activity\?\.shipped_month\}/);
  assert.match(read(HUB), /data-ws-recent-more=\{String\(more\)\} onClick=\{onAll\}/);
  assert.equal(opened, 0);
});
