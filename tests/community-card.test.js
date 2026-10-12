'use strict';

// The community card on a project's Workshop page
// (frontend/src/features/dev-board/workshop/community-card.tsx): who the
// project is for, who is in it, the approval rule, the channel, and Join.
// The server half — GET /api/apps/:slug/community and POST .../membership —
// is pinned against a real database in tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';

test('the approval rule is one sentence per regime, read from the server', () => {
  // In the page's words (first-session run-through, 5 Oct 2026): a change
  // "goes live", people "approve" it. It was "Members vote: a change merges
  // at 2 yes votes (2 active members), or unopposed after a wait."
  const { approvalLine } = loadTsx(CARD);
  const line = (a) => approvalLine({ policy: 'anyone', approvals_required: null, ...a });
  assert.equal(line({ electorate: 12, required: 5 }),
    'A change goes live when 5 of the 12 active members approve it, or after a wait if one approves and nobody objects.');
  assert.equal(line({ electorate: 2, required: 2 }),
    'A change goes live when both active members approve it, or after a wait if one approves and nobody objects.',
    'a two-person group: both of them');
  assert.equal(line({ electorate: 1, required: 1 }),
    'A change goes live when the only active member approves it.',
    'no wait to mention: the quiet path needs a Yes short of the threshold, and one Yes is the threshold');
  const solo = { policy: 'anyone', approvals_required: null, electorate: 1, required: 1 };
  assert.equal(approvalLine(solo, { audience: 'solo', is_member: true }),
    'A change goes live when you approve it.', 'Just you: the one approver is the reader (#4246)');
  assert.equal(approvalLine(solo, { audience: 'solo', is_member: false }),
    'A change goes live when the only active member approves it.', 'a visitor is not the approver');
  assert.equal(approvalLine(solo, { audience: 'invited', is_member: true }),
    'A change goes live when the only active member approves it.', 'a private community keeps the generic line');
  assert.equal(approvalLine({ ...solo, electorate: 2, required: 1 }, { audience: 'solo', is_member: true }),
    'A change goes live when 1 of the 2 active members approves it.', 'only when the reader is the whole electorate');
  assert.equal(line({ electorate: 3, required: 3 }), 'A change goes live when all 3 active members approve it, or after a wait if one approves and nobody objects.');
  assert.equal(line({ electorate: 3, required: 1 }), 'A change goes live when 1 of the 3 active members approves it.');
  assert.equal(approvalLine({ policy: 'anyone', approvals_required: 2, electorate: 30, required: 2 }),
    'A change goes live once 2 members approve it.',
    'a fixed count from dapp.json says the count, not the electorate, and has no wait');
  assert.equal(approvalLine({ policy: 'anyone', approvals_required: 1, electorate: 30, required: 1 }),
    'A change goes live once 1 member approves it.');
  assert.equal(approvalLine({ policy: 'invited', approvals_required: null, electorate: 3, required: 2 }),
    'A change goes live when 2 of the 3 approvers say yes, or after a wait if one says yes and nobody says no.',
    'invited approvers: the same math over the approvers, quiet path included');
  assert.equal(approvalLine({ policy: 'invited', approvals_required: null, electorate: 1, required: 1 }),
    'A change goes live when the only approver says yes.');
  assert.equal(approvalLine({ policy: 'invited', approvals_required: 2, electorate: 3, required: 2 }),
    'A change goes live when 2 of the 3 approvers say yes.', 'at least N approvers: no clock');
  assert.equal(approvalLine({ policy: 'invited', approvals_required: 3, electorate: 2, required: 3 }),
    'A change goes live when 3 approvers (there are 2) say yes.', 'a count larger than the roster says so');
  assert.equal(approvalLine(null), '');
  for (const a of [{ electorate: 12, required: 5 }, { electorate: 2, required: 2 }]) {
    assert.doesNotMatch(line(a), /merge|unopposed|yes vote/, 'no developer words');
  }
  // The card is the rule alone. The note under it, that changing the rules
  // is a change too and goes live only once approved, went (5 Oct 2026).
  assert.doesNotMatch(read(CARD), /Changing these rules|dev-ws-rules-sub/);
  assert.doesNotMatch(read('public/css/app.css'), /\.dev-ws-rules-sub/, 'and its style with it');
});

test('#4527, After-Workshop-B: the rule is one line, worded shorter where the card is narrow', () => {
  const CSS = read('public/css/app.css');
  // The three steps went, and their stacking with them: the rule is the
  // last line of the Overview card.
  assert.doesNotMatch(CSS, /\.dev-ws-rule-step|\.dev-ws-rule-join|\.dev-ws-strip\[data-ws-approval-rules\]/);
  // The card is its own container, so the shorter wording ("Goes live
  // when …") fires when the CARD is narrow — a phone, or beside the side
  // panel — not only when the window is.
  assert.match(CSS, /^\.dev-ws-strip\[data-ws-dashboard\] \{ container-type: inline-size; \}$/m);
  assert.match(CSS, /\.dev-ws-ov-narrow \{ display: none; \}\n@container \(max-width: 520px\) \{\n\s*\.dev-ws-ov-wide \{ display: none; \}\n\s*\.dev-ws-ov-narrow \{ display: inline; \}\n\}/);
  // A rule over it, the shield, the words, then Rules at its far end.
  assert.match(CSS, /\.dev-ws-ov-rule \{\s*margin: 0; padding-top: 10px; border-top: 1px solid var\(--app-sheet-line\);\s*display: flex; align-items: flex-start; gap: 8px;/);
  assert.match(CSS, /\.dev-ws-ov-rule-text \{ flex: 1 1 auto; min-width: 0; \}/);
});

test('the audience line uses the words on screen, and "Just you" counts nobody', () => {
  const { audienceLine } = loadTsx(CARD);
  assert.equal(audienceLine({ audience: 'open', audience_label: 'Public community', member_count: 12 }), 'Public community · 12 members');
  assert.equal(audienceLine({ audience: 'invited', audience_label: 'Private community', member_count: 1 }), 'Private community · 1 member');
  assert.equal(audienceLine({ audience: 'solo', audience_label: 'Just you', member_count: 1 }), 'Just you');
});

test('#4896: the hero says "Just you so far" to the one person in a project nobody else has joined', () => {
  const { justYouSoFar, audienceLine } = loadTsx(CARD);
  assert.equal(justYouSoFar({ audience: 'solo' }, true), 'Just you so far');
  assert.equal(justYouSoFar({ audience: 'solo' }, false), null, 'not to somebody outside it, who is not "you"');
  assert.equal(justYouSoFar({ audience: 'invited' }, true), null);
  assert.equal(justYouSoFar({ audience: 'open' }, true), null);
  // The audience keeps its name everywhere else it is said (the Who can see
  // & change it sheet's line reads audienceLine).
  assert.equal(audienceLine({ audience: 'solo', audience_label: 'Just you', member_count: 1 }), 'Just you');
  assert.match(read('frontend/src/features/dialogs/who-decides.tsx'), /audience: audienceLine\(community\)/);
  const src = read(CARD);
  assert.match(src, /data-ws-community-audience="">\{justYouSoFar\(data, member\) \|\| audienceLine\(data\)\}<\/span>/,
    'under the name, out of the first week');
  assert.match(src, /audienceLabel=\{justYouSoFar\(data, member\) \|\| data\.audience_label\}/,
    'and on the first week\'s people row');
});

test('before the read the hero draws only what needs none: Open app and the ⋯', () => {
  // No server render of it, so no hydration to mismatch. The tile and the
  // name come with the read (HeroIdentity), so before it the hero is the
  // actions that depend on nothing it says, or nothing at all; the fetch
  // runs in an effect.
  const { CommunityCard } = loadTsx(CARD);
  assert.equal(renderToHtml(createElement(CommunityCard, { slug: 'notes' })), '');
  const pending = renderToHtml(createElement(CommunityCard, { slug: 'notes', name: 'Notes', canOpenApp: true }));
  assert.match(pending, /class="dev-ws-hero" data-ws-community-pending=""/);
  assert.match(pending, /<button type="button" class="dev-ws-open-app" data-ws-community-open-app="">/);
  // Open app wears the community's colour from the root, where the header
  // sets it (features/header/community-tint.ts), not from a prop.
  assert.match(read('public/css/app.css'), /\.dev-ws-open-app \{[^}]*background: var\(--community-tint, var\(--accent\)\)/);
  assert.doesNotMatch(pending, /dev-ws-hero-name|data-ws-community=""|Join|data-ws-community-rule/,
    'no name before the read says it, and nothing that depends on membership before it is known');
  const src = read(CARD);
  // ONE READ FOR THE HUB: the hero and the hub's cards share the community
  // record, and each mount asks for a fresh copy unless one is on its way.
  assert.match(src, /const data = useCommunity\(slug\);/);
  assert.match(src, /if \(slug && !inflight\.has\(slug\)\) void reloadCommunity\(slug\);/);
});

test('the channel is a hub card at its old address; Join asks under its button and joins through offerJoin', () => {
  const src = read(CARD);
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.doesNotMatch(src, /#messages\/app\//, 'the hero no longer carries a channel row');
  // The hub's way to the room is For you's Discussion row, which opens the
  // page's own Discussion place (the room at its address lives there).
  assert.match(hub, /data-ws-channel="preview"\s+data-ws-channel-open=""\s+data-ws-channel-handle=\{channel\.handle \|\| undefined\}\s+onClick=\{onOpen\}/,
    'the hub\'s Discussion row is a door to the Discussion place');
  assert.doesNotMatch(hub, /#messages\/app\//, 'and links to no second copy of the room');
  assert.match(src, /await offerJoin\(\{ code: 'join_required', app: \{ slug, name: name \|\| data\.name \|\| slug \} \}\)/,
    'the button asks the question every refusal asks, through the same function');
  assert.match(src, /registerJoinAnchor\(slug, \{/,
    'and while it shows, the hero is where that question is asked');
  assert.match(src, /getClientRects\(\)\.length > 0/,
    'but only while it is actually on screen');
  assert.match(src, /className="dev-ws-join-pop"[\s\S]*className="dev-ws-ask-q"[\s\S]*className="dev-ws-vote-sub"[\s\S]*dev-ws-answer-btn dev-ws-answer-join[\s\S]*className="dev-ws-vote-later"/,
    'the popup wears the vote popover\'s question, line, answer and "later"');
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-join-pop \{\s*position: absolute; top: calc\(100% \+ 12px\)/,
    'it hangs from the button');
  assert.match(css, /\.dev-ws-hero \.dev-ws-hero-member \.dev-ws-join-pop \{ left: auto; right: -6px; \}/,
    'from its right edge in the hero, where Join ends the actions row (#852)');
  // #4045: Leave is a row of the hub's ⋯ (it was the Joined pill), through
  // the same call Discover makes, and never the creator's.
  assert.match(src, /home\.setMembership\(slug, false\)/, 'Leave goes through the same call Discover makes');
  assert.doesNotMatch(src, /data-ws-community-leave=""|>\s*Joined\s*</, 'no Joined pill on the hero');
  assert.match(src, /return !!data && !!data\.is_member && !data\.is_creator;/, 'the creator is never offered Leave');
  // #3362: Invite is invite LINKS, which any member can make
  // (services/community-invites.js); Members & approvals stays the ⋯'s, behind
  // its own gate.
  // `member` is is_member, except under `?shot=invite-join`, which draws the
  // hero as an invitee sees it (#3700).
  assert.match(src, /const member = data\.is_member && !offer\?\.preview;/);
  // #4896: on a project that is just yours too, beside "Just you so far":
  // it was left to the Share it card, and a newcomer met "Just you" alone.
  assert.match(src, /\{member \? \(\s*<Button[\s\S]{0,160}data-ws-community-invite=""/,
    'Invite is offered to members, a project of one included');
  assert.doesNotMatch(src, /_plusMenuShowsMembers/, 'not by the members dialog\'s gate');
});

test('the hero leads the hub, above what is for you and what went live; who is around is the hero\'s (#3268)', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const tab = lander.indexOf("{tab === 'status' ? (");
  const hero = lander.indexOf('<CommunityCard\n          slug={slug}');
  const forYou = lander.indexOf('<ForYouCard');
  const recent = lander.indexOf('<RecentlyLive');
  assert.ok(tab > 0 && hero > tab && forYou > hero && recent > forYou,
    'first on the hub, then For you and Recently live');
  assert.doesNotMatch(lander, /<MembersCard|<NeedsCard|<ChannelCard|<GoingCard/,
    'no separate Members & activity, Needs you, channel or metrics card');
  // The hub's head: its tile and name are the page's own record of the app,
  // the header chip's (improveStore), once it is about this project.
  assert.match(lander, /<CommunityCard\s+slug=\{slug\}\s+name=\{app\.name \|\| undefined\}\s+iconUrl=\{own \? app\.iconUrl : null\}\s+iconEmoji=\{own \? app\.iconEmoji : null\}\s+canOpenApp=\{!actions\.selfHosted\}/,
    'its tile and name are the header chip\'s');
});
