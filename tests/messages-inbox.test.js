'use strict';

// Messages is one inbox (#2718).
//
// It was the `conversations` domain and nothing else. An app's own
// discussion lived on that app's board and a change in flight lived in the
// Improve panel's list, so neither was findable from the one screen somebody
// opens looking for "what was said to me". One list, a mark on the rows that
// are not a person — which is what Slack and Teams do with a channel, a DM
// and a bot thread in one sidebar.
//
// Five things are pinned, and each is a way one list becomes three stacked:
//
//   1. ONE CLOCK, newest first.
//   2. A ROW WITH NO TIMESTAMP SORTS LAST. "We do not know when" is not
//      "just now".
//   3. CHANGES ARE NOT LISTED HERE (16 Nov 2026): Messages reads nothing
//      from the Improve store. The changes in flight are listed on the
//      Homeroom bot tab, the Homeroom menu and each project's Workshop.
//   4. THE DISCUSSIONS READ FAILS QUIETLY. Conversations are this screen's
//      reason to exist; a second request must not be able to blank it.
//   5. MEMBERSHIP, NOT VISIBILITY. A public app you have never joined is
//      something to go and read, not something in your messages. (#2967
//      widens this to "an app you have taken part in", in a second "more"
//      section — still never an app you have not touched, and never one you
//      cannot open.)
//
// #2783 sectioned the list the way Discord does: the chats, then the
// CHANNELS — #general, then one per app the viewer is a member of.
//
// 16 Oct 2026: the channels live on their hubs now, and the one clock was
// split into two headed sections: Agents (the changes in flight), then
// People. The filter chips went with it. 16 Nov 2026: Agents left Messages,
// so the list is People alone, under its heading, on one clock, and nothing
// folds.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const ROUTE = read('src/routes/messages-overview.js');

const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

const at = (iso) => iso;

test('one list on one clock; the channels are not listed here: they live on their hubs', () => {
  const merged = inbox.buildInbox({
    conversations: [
      { id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') },
      { id: 9, kind: 'channel', lastActivityAt: at('2026-01-09T00:00:00Z') },
      { id: 4, lastActivityAt: at('2026-01-05T00:00:00Z') },
    ],
  });
  // Messages is people. #general is the Homeroom community's channel and
  // each app's channel is its own community's, drawn on the hub
  // (features/dev-board/workshop/hub-cards.tsx), so neither is a row.
  assert.deepEqual(merged.map((e) => e.key), ['person:4', 'person:1']);
  assert.deepEqual(merged.map((e) => e.kind), ['person', 'person']);
});

test('a row with no timestamp sorts last, not first', () => {
  const merged = inbox.buildInbox({
    conversations: [
      { id: 1, lastActivityAt: null },
      { id: 2, lastActivityAt: at('2019-01-01T00:00:00Z') },
      { id: 3, lastActivityAt: at('2020-01-01T00:00:00Z') },
    ],
  });
  assert.deepEqual(merged.map((e) => e.key), ['person:3', 'person:2', 'person:1']);
});

test('one heading, People, and there are no filter chips and no Agents', () => {
  assert.equal(inbox.INBOX_SECTIONS, undefined, 'one section: there is no list of them');
  assert.equal(message('messages:inbox.section.people'), 'People',
    'audit C02: it holds group chats too, so it is not headed "Direct messages"');
  assert.throws(() => message('messages:inbox.section.agents'), 'Agents is no heading of Messages any more');
  assert.equal(inbox.INBOX_FILTERS, undefined, 'the chips went: the heading says what the rows are');
  assert.equal(inbox.admits, undefined);
  assert.doesNotMatch(SCREEN, /InboxFilters|setFilter|messages-filter/);
  const people = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }, { id: 9, kind: 'channel', lastActivityAt: null }],
  });
  assert.deepEqual(people.map((e) => e.key), ['person:1'], 'a channel is no one\'s person row');
});

test('#6019: the Homeroom bot\'s DM is the AI tab, not a row of Messages', () => {
  const conversations = [
    { id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') },
    { id: 2, kind: 'direct', homeroomBot: true, lastActivityAt: at('2026-01-01T00:00:00Z') },
  ];
  const merged = inbox.buildInbox({ conversations });
  assert.deepEqual(merged.map((e) => e.key), ['person:1'], 'its row left the list');
  assert.deepEqual(merged.map((e) => Object.keys(e).sort()), [['at', 'key', 'kind']], 'no section and nothing pinned');
  assert.match(SCREEN, /conversations: snap\.conversations,/, 'the screen hands the merge the summaries that carry the mark');
});

test('the discussions read fails quietly', () => {
  const fn = STORE.slice(STORE.indexOf('async function readAppDiscussions'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!response\.ok\) return;/, 'a bad status changes nothing');
  assert.match(body, /\} catch \{/, 'and neither does being offline');
  assert.doesNotMatch(body, /publish\(\{ error/, 'it never blanks the conversations');
});

// #6591: a page load that lands on Messages asked for the discussions twice
// in the same moment, the store filling at sign-in and the screen opening.
test('the discussions reads that say nothing new share one request; a read after a change asks again', () => {
  const fn = STORE.slice(STORE.indexOf('export function loadAppDiscussions'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(join && discussionsRead\) return discussionsRead;/, 'a joining read takes the one in flight');
  assert.match(body, /if \(discussionsRead === read\) discussionsRead = null;/, 'and nothing is kept once it lands');
  assert.equal((STORE.match(/loadAppDiscussions\(\{ join: true \}\)/g) || []).length, 4, 'sign-in (twice) and the two opens join');
  for (const after of ['async function refreshBlockedView', 'export async function resync', '  refresh: () => {']) {
    const at = STORE.indexOf(after);
    assert.ok(at > 0, after);
    assert.match(STORE.slice(at, at + 200), /void loadAppDiscussions\(\);/, `${after.trim()} asks the server itself`);
  }
});

test('the "+" sits beside the search, and opens a choice rather than guessing (#2778)', () => {
  // It was a disc at the far end of the filter row, taken off in #2718's
  // review because ONE control could only mean one of the things the inbox
  // holds, and came back as a popover of choices: DM and group (an agent
  // chat was the third until agent chats were retired). The filter row went
  // (16 Oct 2026), so it sits beside the search.
  const toolbar = SCREEN.slice(SCREEN.indexOf('<div className="messages-toolbar">'));
  const body = toolbar.slice(0, toolbar.indexOf('<NewMessageButton />') + 20);
  assert.ok(body.indexOf('id="messages-search"') > 0 && body.indexOf('id="messages-search"') < body.indexOf('<NewMessageButton />'),
    'the plus sits after the search, to its right');
  assert.ok(!SCREEN.includes('function InboxCompose'), 'the row of compose buttons under the strip is gone');
  assert.ok(!SCREEN.includes('id="messages-new-agent"'));

  const button = SCREEN.slice(SCREEN.indexOf('function NewMessageButton'));
  const fn = button.slice(0, button.indexOf('\n}\n'));
  assert.match(fn, /id="messages-new"/);
  assert.match(fn, /aria-haspopup="menu"/);
  // THE VOTE POPUP'S MECHANICS, shared rather than copied: placement from
  // the button's rect, dismissal on outside click / Escape / scroll / resize.
  assert.match(fn, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/);
  // B8: sized to its rows.
  assert.match(fn, /placeUnderAnchor\(rect, \{ width: 260, height: 54 \* NEW_CHOICES\.length \+ 2 \}/);
  assert.match(fn, /createPortal\(/, 'portalled, so the list\'s scroller cannot clip it');
  assert.match(fn, /role="menu"/);
  assert.match(fn, /pu\.actionSheet\(\{/, 'a phone gets the kit\'s action sheet');
  const card = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(card, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/, 'the vote picker reads the same helper');
  assert.match(card, /placeUnderAnchor\(rect, \{ width: w, height: h \}/);

  assert.equal(message('messages:inbox.new.direct.label'), 'Direct message');
  assert.match(SCREEN, /\{ key: 'direct', label: 'messages:inbox\.new\.direct\.label'/);
  assert.equal(message('messages:inbox.new.group.label'), 'Group chat');
  assert.match(SCREEN, /\{ key: 'group', label: 'messages:inbox\.new\.group\.label'/);
  // Homeroom bot is out of the menu: it starts new conversations on its own
  // tab, and agent chats are retired.
  assert.throws(() => message('messages:inbox.new.bot.label'));
  assert.throws(() => message('messages:inbox.new.bot.hint'));
  assert.throws(() => message('messages:inbox.new.agent.label'));
  assert.doesNotMatch(SCREEN, /key: 'bot'/);
  assert.doesNotMatch(SCREEN, /key: 'agent'/);
  assert.doesNotMatch(SCREEN, /hasHomeroomBot/);
  // The order is Direct message, then Group chat.
  const directAt = SCREEN.indexOf("key: 'direct'");
  const groupAt = SCREEN.indexOf("key: 'group'");
  assert.ok(directAt > -1 && groupAt > directAt, 'the menu is Direct message, Group chat');
  const start = SCREEN.slice(SCREEN.indexOf('function startNew'));
  const starter = start.slice(0, start.indexOf('\n}\n'));
  assert.doesNotMatch(starter, /openBot/, 'Homeroom bot is not a new conversation to start');
  assert.match(starter, /openDialog\('messagesCreate', choice\);/,
    'DM and group open the create flow on the matching tab');
  const create = read('frontend/src/features/messages/create-dialog.tsx');
  assert.match(create, /setMode\(tab === 'group' \? 'group' : 'direct'\)/);
});

test('the "+" asks no app first and opens no classic session any more (#2779)', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/messages/agent-dialog.tsx')), false,
    'the "which app?" dialog led to a classic dev session, which is no longer created');
  assert.doesNotMatch(SCREEN, /messagesAgent|agentSessionsEnabled/);
  const improve = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(improve, /startSessionFor/);
});

test('the endpoint lists yours then more, one row per app, never an app the viewer cannot open', () => {
  // #2967 widened #2783's members-only scope into two sections: "yours" is
  // Home's `isYours` (member and not hidden from Your apps, or favorited),
  // "more" is every other app the viewer took part in. Pinned by clause
  // here; tests/app-chat-postgres.test.js runs the SQL against the real
  // schema.
  assert.match(ROUTE, /FROM app_collaborators me\s+WHERE me\.user_id = \$1 AND me\.status = 'member'/,
    'membership is one way in');
  assert.match(ROUTE, /LEFT JOIN app_favorites fav ON fav\.app_id = a\.id AND fav\.user_id = \$1/,
    'a favorite (or a hidden-from-Your-apps opt-out) is read per viewer');
  assert.match(ROUTE, /WHEN \(member\.app_id IS NOT NULL AND NOT COALESCE\(fav\.hidden, FALSE\)\)\s+OR \(fav\.app_id IS NOT NULL AND NOT fav\.hidden\)\s+OR home_pin\.community_id IS NOT NULL\s+THEN 'yours'/,
    'yours = Home.isYours: a visible membership, or a favorite, or (One Home, #6361) its community pinned to Home');
  assert.match(ROUTE, /LEFT JOIN home_community_pins home_pin ON home_pin\.community_id = a\.community_id AND home_pin\.user_id = \$1/,
    'the Home pin is read per viewer, by the app\'s community');
  for (const [source, why] of [
    [/FROM chat_messages posted\s+WHERE posted\.user_id = \$1/, 'posted in its chat'],
    [/FROM message_reactions reaction/, 'reacted in its chat'],
    [/FROM pr_votes vote/, 'voted on a proposal'],
    [/FROM issue_votes vote/, 'voted on a governance question'],
    [/FROM chat_sessions proposed[\s\S]{0,120}is_headless = FALSE/, 'proposed a change (not an auto session)'],
    [/FROM issues filed\s+WHERE filed\.created_by = \$1/, 'filed a request'],
  ]) assert.match(ROUTE, source, `activity: ${why}`);
  // Visibility is the app routes' view rule, whatever put the app in scope.
  assert.match(ROUTE, /\(\$2::boolean OR a\.view_visibility = 'public' OR member\.app_id IS NOT NULL\)/,
    'an app gone view-private drops out for a non-member, favorite or no favorite');
  assert.match(ROUTE, /NOT a\.self_hosted OR \$2::boolean/,
    'and the platform’s own app keeps its admin gate');
  assert.match(ROUTE, /WHERE a\.moderation_suspended_at IS NULL\s+AND \(NOT a\.self_hosted/,
    'an app suspended by moderation refuses to open, so it is no discussion either');
  assert.match(ROUTE, /AND view_visibility = 'public' AND NOT self_hosted\s+AND moderation_suspended_at IS NULL/,
    'nor a staging demo row');
  assert.match(ROUTE, /SELECT DISTINCT ON \(m\.app_id\)/, 'one row per app');
  assert.match(ROUTE, /ORDER BY m\.app_id, m\.created_at DESC, m\.id DESC/,
    'the id tiebreak matters: created_at defaults to NOW() and two messages '
    + 'in one transaction share it');
  assert.match(ROUTE, /WHERE m\.thread_type IS NULL\s+AND m\.deleted_at IS NULL/,
    'the general thread, not a card’s or a reply thread’s, and never a deleted message');
  // #2783: EVERY app in scope is a channel, including one nobody has
  // spoken in — so the latest message is joined optionally, and those sort
  // after the ones with activity.
  assert.match(ROUTE, /LEFT JOIN latest ON latest\.app_id = mine\.id/);
  assert.match(ROUTE, /ORDER BY \(mine\.section = 'yours'\) DESC,\s+latest\.created_at DESC NULLS LAST, LOWER\(mine\.name\), mine\.slug/,
    'yours before more; newest first inside each, silent last');
  // #2387 gives chat_messages a per-viewer read cursor (app_chat_reads), so
  // the count this test used to forbid is now a real one — and it is
  // computed from that cursor, not invented.
  assert.match(ROUTE, /JOIN app_chat_reads rc ON rc\.app_id = m\.app_id AND rc\.user_id = \$1/);
  assert.match(ROUTE, /m\.id > rc\.last_read_message_id/);
  assert.match(ROUTE, /m\.user_id IS NOT NULL AND m\.user_id <> \$1/,
    'from other people: your own lines and authorless system lines are not unread');
  assert.match(ROUTE, /appChat\.ensureReadCursors\(pool, req\.user\.id, missing\)/,
    'an app seen for the first time starts at zero');
});

test('the route is registered after the workshop one', () => {
  const server = read('server.js');
  assert.match(server, /const \{ messagesOverviewRoutes \} = require\('\.\/src\/routes\/messages-overview'\);/);
  assert.match(server, /app\.use\(messagesOverviewRoutes\(config\)\);/);
});

test('the search and the plus ship in the prerendered document; the filter row is gone', () => {
  for (const id of ['messages-search', 'messages-new']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is in the shipped shell`);
  }
  for (const id of ['messages-filters', 'messages-filter-all', 'messages-filter-people', 'messages-filter-agents',
    'messages-filter-apps', 'messages-filter-channels', 'messages-compose', 'messages-new-agent']) {
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is retired`);
  }
  assert.match(HTML, /<div class="messages-toolbar"><div class="messages-search">[\s\S]*?id="messages-search"[^>]*\/><\/div><button[^>]*id="messages-new"/,
    'the plus is right after the search, on its line');
  assert.ok(!HTML.includes('id="messages-new-menu"'), 'the popover renders only when pressed');
  assert.ok(!HTML.includes('data-inbox-section'), 'the sections draw once the rows arrive, after mount');
});

test('one row shape, under one People heading; nothing folds and nothing waits behind "older"', () => {
  assert.doesNotMatch(SCREEN, /ChangeRow|ChangeTile|SessionRow/, 'a change has no row in Messages any more');
  assert.doesNotMatch(SCREEN, /MayorSessionRow/, 'an agent chat has no row any more');
  assert.doesNotMatch(SCREEN, /<KindPill kind="app" \/>/, 'a section heading says it once');
  assert.doesNotMatch(SCREEN, /SECTION_LABELS|INBOX_SECTIONS|shownInSection|agentAsksForYou|agentsExpanded/);
  assert.doesNotMatch(SCREEN, /data-inbox-session|data-inbox-fold|data-inbox-more|messages-inbox-older|messages-section-toggle/);
  for (const name of ['shownInSection', 'sectionRuns', 'agentAsksForYou', 'AGENTS_SHOWN', 'AGENTS_RECENT_DAYS']) {
    assert.equal(inbox[name], undefined, `${name} went with Agents`);
  }
  // The heading: People in small caps and the unread count, never a fold.
  const head = SCREEN.slice(SCREEN.indexOf('function PeopleHead'));
  const fn = head.slice(0, head.indexOf('\n}\n'));
  assert.match(fn, /<h3 className="messages-section-head" data-inbox-section="people">\s*<span className="messages-section-name">\{t\('messages:inbox\.section\.people'\)\}<\/span>\s*\{aside \? <span className="messages-section-aside">\{aside\}<\/span> : null\}\s*<\/h3>/);
  assert.doesNotMatch(fn, /<button|onClick/, 'the heading is no button: nothing folds');
  // The rows, in a card under it, once there are any to show.
  assert.match(SCREEN, /\{found\.length \? \(\s*<>\s*<PeopleHead aside=\{unreadAside\} \/>\s*<div className="messages-section-card" data-inbox-card="people">\s*\{found\.map\(inboxRow\)\}\s*<\/div>/,
    'the rows in a card of their own, so the last row drops its separator');
  for (const id of ['messages:inbox.older.show_one', 'messages:inbox.older.show_other', 'messages:inbox.older.hide']) {
    assert.throws(() => message(id), `${id} went with the Agents fold`);
  }
  const conversationRow = SCREEN.slice(SCREEN.indexOf('function ConversationRow'), SCREEN.indexOf('const GeneralChannelRow = memo('));
  assert.doesNotMatch(conversationRow, /KindPill/,
    'a person gets none: they are the majority, and a pill on every row says nothing');
});

test('nothing folds, so nothing about folding is remembered (16 Nov 2026)', () => {
  // Agents folded from its heading and the device remembered it
  // (usernode:messages-folded). People never folded, so with Agents gone
  // the store keeps no folded sections at all.
  assert.doesNotMatch(STORE, /usernode:messages-folded|setSectionFolded|savedFolded|FOLDABLE|folded:/,
    'the folded sections are neither read nor written');
  assert.doesNotMatch(STORE, /usernode:messages-filter/, 'nor the retired filter');
  assert.match(STORE, /publish\(\{ online: navigator\.onLine, demo: browserDemo\(\), listCollapsed, showMoreChannels \}\)/,
    'the two layout preferences still arrive after mount, so the first paint matches the prerendered shell');
});

test('the bot\'s row says what waits on you, and the heading counts what is unread', () => {
  // Its chat's own activity bar words, from the same store, once it has read.
  assert.match(SCREEN, /const parts = summaryParts\(stripGroups\(botWork\.work\)\);/);
  assert.match(SCREEN, /return parts\.length \? parts\.slice\(0, 2\)\.map\(\(part\) => part\.text\)\.join\(' · '\) : null;/);
  // #5392: the row stays current: again whenever the list opens and when a
  // request's stage moves (5 Nov 2026: a push, never a timer).
  assert.match(SCREEN, /if \(mounted && botConversation\) loadBotWork\(\);/, 'fresh, after mount and whenever the bot\'s last activity moves');
  assert.match(SCREEN, /useWorkChanged\(!!botConversation\);/, 'again when a request\'s stage moves');
  assert.doesNotMatch(SCREEN, /loadBotWork\(\);\s*\}, POLL_MS\)/, 'no timer');
  assert.match(SCREEN, /preview=\{conversation\.homeroomBot \? botLine : null\}/);
  // #5393: a group's preview names its last sender ahead of this; the bot's
  // own line (`preview`) still leads the fallback the DM rows draw.
  assert.match(SCREEN, /: groupPreview \?\? \(ownDirection\(preview \|\| conversation\.latestSummary \|\| ''\) \|\| t\('messages:inbox\.noMessages'\)\)/,
    'its last message until then — the bot\'s own line first, then a group\'s sender-prefixed one');
  assert.throws(() => message('messages:inbox.section.working', { count: 1 }), 'no Agents heading to say "1 working"');
  assert.equal(message('messages:inbox.section.unread', { count: 3 }), '3 unread');
  assert.match(SCREEN, /const unreadAside = unreadFromPeople \? t\('messages:inbox\.section\.unread', \{ count: unreadFromPeople \}\) : null;/,
    'a zero says nothing');
  assert.doesNotMatch(SCREEN, /messages-section-aside-ask/, 'and the people count is grey: new to read, not waiting on you (#18)');
});

test('#5393: a group row shows its members\' faces and names the person who spoke last', () => {
  // The tile is the people in it, not the title's first letters. Only
  // people who have joined count; the viewer is never one of the faces; at
  // most two are drawn, stacked in the same 44px box the `lg` square takes
  // so the row's separator inset holds.
  const faces = SCREEN.slice(SCREEN.indexOf('function GroupFaces('), SCREEN.indexOf('const ConversationRow = memo('));
  assert.ok(faces.length > 0, 'GroupFaces is defined before the row');
  assert.match(faces, /member\.status === 'member' && Number\(member\.id\) !== viewerId/,
    'joined members only, and never the viewer');
  assert.match(faces, /\.slice\(0, 2\)/, 'two faces at most');
  assert.match(faces, /<span className="messages-group-faces" aria-hidden="true">/, 'two members: the stacked pair');
  assert.match(faces, /<UserAvatar user=\{others\[0\]\} size="sm" shape="square" \/>/, 'each face the kit\'s own sm square');
  // The row draws it for a group the viewer is in; a DM and an unanswered
  // invitation keep today's tile.
  const row = SCREEN.slice(SCREEN.indexOf('const ConversationRow = memo('), SCREEN.indexOf('const GeneralChannelRow = memo('));
  assert.match(row, /conversation\.kind === 'group' && !invited\s*\? <GroupFaces conversation=\{conversation\} \/>/);
  assert.doesNotMatch(row.slice(row.indexOf('<UserAvatar')), /<GroupFaces/, 'the fallback tile is the old one');
  // The preview names its last sender, the way #general's row already does.
  assert.match(row, /const groupSender = conversation\.kind === 'group' && !invited\s*\? conversation\.latestMessage\?\.sender \|\| null\s*: null;/);
  assert.match(row, /t\('messages:inbox\.previewYou', \{ message: ownDirection\(conversation\.latestSummary\) \}\)/, 'the viewer\'s own message reads "You: …"');
  assert.match(row, /t\('messages:inbox\.previewBy', \{ username: groupSender\.username, message: ownDirection\(conversation\.latestSummary\) \}\)/, 'anyone else reads "@name: …"');
  assert.equal(message('messages:inbox.previewYou', { message: 'hi' }), 'You: hi');
  assert.equal(message('messages:inbox.previewBy', { username: 'ada', message: 'hi' }), '@ada: hi');
  // The pair keeps the row's own geometry: a 44px box on the 74px inset.
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-group-faces \{ position: relative; flex: 0 0 44px; width: 44px; height: 44px; \}/);
  assert.match(css, /\.messages-conversation-row::after \{[^}]*inset-inline-start: 74px;/);
  assert.match(css, /\.messages-group-faces > :last-child \{ inset-inline-end: 0; bottom: 0; box-shadow: 0 0 0 2px var\(--dc-sheet-solid, var\(--app-bg\)\); \}/);
  // The sidebar nested the latest conversations with one face each (v3)
  // until 7 Nov 2026; nothing is nested under Messages now.
  assert.doesNotMatch(SCREEN, /function railRow\(/);
  assert.doesNotMatch(css, /platform-rail-face/);
});

test('on a desktop with nothing open the list is the page, and a place lit in the sidebar wears the lit ink (v3)', () => {
  const css = read('public/css/app.css');
  // The list stood beside the strip as a 264px column of compact rows; the
  // sidebar of rows is on every desktop window now, and the list is a page.
  const P = 'html:not(.un-kb) body:has(#platform-tabs:not(.hidden):not(.platform-tabs-peek):not(.platform-tabs-folded)) #messages-screen > .messages-layout > .messages-list-pane';
  assert.ok(!css.includes(`${P} .messages-conversation-row {`), 'no compact column rows');
  assert.ok(!css.includes(`${P} {`), 'no column');
  assert.match(css, /\.messages-layout\.messages-list-page > \.messages-list-pane \{\n    flex: 1 1 auto;/);
  assert.doesNotMatch(css, /messages-more-channels/, 'the chevron row is gone');
  // A place open under a community's row is lit like a tab.
  assert.match(css, /\.platform-rail-nest :is\(\.dev-ws-place, \.platform-rail-sub\)\[aria-current="page"\] \{\n    background: var\(--lit-tint\);\n    color: var\(--lit-ink\);/);
});

test('Messages draws no change in flight, and reads nothing from the Improve store (16 Nov 2026)', () => {
  // The changes are listed on the Homeroom bot tab, the Homeroom menu and
  // each project's Workshop; Messages is conversations alone.
  assert.doesNotMatch(SCREEN, /improveStore|improve-store|improve-controller|session-row|Improve\.loadSessions/,
    'neither the store nor its load nor its row');
  assert.doesNotMatch(SCREEN, /notificationsStore|sessionUnreadIds/, 'nor the news marks a change row carried');
  assert.doesNotMatch(SCREEN, /useMessages\('agent'\)/, 'nor the words a change in flight is said in');
  assert.doesNotMatch(read('frontend/src/features/messages/inbox.ts'), /sessions\??:|'session'|ChangeInFlight/, 'the merge takes conversations alone');
  assert.doesNotMatch(STORE, /sessions:/, 'and this store holds no copy of that list');
  // Messages was the Improve store's list's last surface, so the list and
  // its row went too (tests/improve-work-order-rows.test.js).
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/features/improve/session-row.tsx')), false,
    'the change row has no surface left');
  assert.doesNotMatch(read('frontend/src/features/improve/improve-store.js'), /^\s+(sessions|otherSessions|sessionsLoaded|loadingSessions): /m,
    'nor does the store hold the list');
  // Their styles left with them.
  const css = read('public/css/app.css');
  for (const rule of ['.messages-inbox-session', '.messages-inbox-change-tile', '.messages-inbox-older', '.messages-section-toggle', '.messages-section-chevron', '.messages-section-aside-ask', '[data-inbox-unseen]']) {
    assert.ok(!css.includes(rule), `${rule} has no rule left`);
  }
});

// ── Channels as things a message can name (#2783) ─────────────────────

const channels = loadTsx('frontend/src/features/messages/channels.ts');
const overview = require('../src/routes/messages-overview');

test('#general and the viewer\'s apps are the channel directory, #general first', () => {
  const list = channels.channelDirectory(
    [{ id: 3, kind: 'direct', title: 'ada' }, { id: 7, kind: 'channel', title: 'general', channelKey: 'general' }],
    [{ slug: 'recipe-ab12', name: 'Recipe Box', channel: 'recipe-box' }, { slug: 'Odd_Slug', name: '42' }],
  );
  assert.deepEqual(list.map((c) => [c.handle, c.target]), [
    ['general', '#messages/7'],
    ['recipe-box', '#messages/app/recipe-ab12'],
  ], 'a handle must start with a letter, so an app whose only name is a number has none to be named by');
  assert.equal(channels.channelHref('general'), '#messages/channel/general');
});

test('#name is a channel only when the viewer has one; #123 stays an issue and PR#123 a PR', () => {
  const known = new Set(['general', 'recipe-box']);
  const segs = channels.tokenizeRefs('see #general and #recipe-box, not #todo — #123 and PR#9 @ada', known);
  assert.deepEqual(segs.filter((s) => s.type !== 'text'), [
    { type: 'channel', handle: 'general' },
    { type: 'channel', handle: 'recipe-box' },
    { type: 'ref', isPr: false, num: '123' },
    { type: 'ref', isPr: true, num: '9' },
    { type: 'mention', name: 'ada' },
  ]);
  assert.equal(segs.map((s) => s.value || '').join('').includes('#todo'), true, 'an unknown #word is left as text');
  assert.deepEqual(channels.tokenizeRefs('x#general', known), [{ type: 'text', value: 'x#general' }],
    'not inside a word');
  assert.deepEqual(channels.tokenizeRefs('thanks @homeroombot', known), [
    { type: 'text', value: 'thanks ' },
    { type: 'mention', name: 'homeroombot' },
  ], 'the no-space bot handle is one mention');
  assert.equal(channels.isBotMention('HomeroomBot'), true);
  assert.equal(channels.isBotMention('homeroombot'), true);
  assert.equal(channels.isBotMention('homeroombotx'), false);
});

test('the app chat chips the same channels, as a link and not as a drawer ref', () => {
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /window\.UsernodeReact\?\.messages\?\.channels\?\.\(\)/, 'it reads the Messages store\'s directory');
  assert.match(gc, /link\.className = 'gc-channel-ref';/);
  assert.match(gc, /return \{ href: `#messages\/channel\/\$\{handle\}`, handle, topic: false \};/);
  // #4417: inside a project, its topics' handles (and the ones they had
  // before a rename) come first, and link to the topic's channel there.
  assert.match(gc, /window\.UsernodeReact\?\.places\?\.topicHandles\?\.\(slug\)/);
  assert.match(gc, /href: `#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/c\/\$\{topic\}`, handle: topic, topic: true/);
  assert.doesNotMatch(gc, /gc-ref gc-ref-channel/, 'never `.gc-ref`, which the chat sends to the activity drawer');
  const app = read('public/js/app.js');
  assert.match(app, /parts\[1\] === 'channel'[\s\S]{0,160}openChannel\?\.\(parts\[2\] \|\| ''\)/);
  assert.match(STORE, /export function openChannel\(raw: string\): void/);
  assert.match(STORE, /window\.location\.replace\(found\.target\)/, 'the link\'s own history entry is replaced');
});

test('an app\'s channel handle is its name folded, unique within the viewer\'s list', () => {
  assert.equal(overview.channelHandle('Recipe Box!'), 'recipe-box');
  assert.equal(overview.channelHandle('42'), null);
  const list = overview.channelHandles([
    overview.toDiscussion({ slug: 'recipe-ab12', name: 'Recipe Box' }),
    overview.toDiscussion({ slug: 'recipe-cd34', name: 'recipe box' }),
    overview.toDiscussion({ slug: 'general-99', name: 'General' }),
  ]);
  assert.deepEqual(list.map((d) => d.channel), ['recipe-box', 'recipe-cd34', 'general-99'],
    'a second "Recipe Box" and an app named General fall back to their slugs');
  // #2967: the handles stay unique across BOTH sections — a `#name` in a
  // message resolves against the whole list, not one half of it.
  const sectioned = overview.channelHandles([
    overview.toDiscussion({ slug: 'notes-a1', name: 'Notes', section: 'yours' }),
    overview.toDiscussion({ slug: 'notes-b2', name: 'Notes', section: 'more' }),
  ]);
  assert.deepEqual(sectioned.map((d) => [d.section, d.channel]), [['yours', 'notes'], ['more', 'notes-b2']]);
});

test('a discussion row carries its section and unread count (#2967, #2387)', () => {
  const row = overview.toDiscussion({
    slug: 'recipe-ab12', name: 'Recipe Box', section: 'more', unread_count: '4',
    last_message: 'hi', last_at: '2026-01-02T00:00:00Z', last_by: 'ada',
  });
  assert.equal(row.section, 'more');
  assert.equal(row.unreadCount, 4, 'COUNT(*) arrives as a number; a string one is coerced');
  const bare = overview.toDiscussion({ slug: 'x', name: 'X' });
  assert.equal(bare.section, 'yours', 'anything but "more" is yours');
  assert.equal(bare.unreadCount, 0);
});

test('an app channel opened in Messages mounts its chat after React commits, so its composer is wired', () => {
  // renderGroupChatTab mounts the chat as a portal and then looks up
  // `#gc-input` to wire send, drafts and the @ / # menus. Called inside the
  // effect, the portal could not flush and nothing typed there ever sent.
  const thread = SCREEN.slice(SCREEN.indexOf('function AppDiscussionThread'));
  const body = thread.slice(0, thread.indexOf('\n}\n'));
  assert.match(body, /const timer = window\.setTimeout\(\(\) => \{\s*if \(live\) view\?\.renderGroupChatTab\?\.\(\{ host: el, slug, name, readOnly, archived \}\);\s*\}, 0\);/);
  assert.match(body, /live = false;\s*window\.clearTimeout\(timer\);/);
});

// ── Bug h: the discussion pane's header tile is the app's own ────────────
//
// The pane header built its tile from `{ name }` alone, so `iconViewFor`
// could only ever fall through to the name's first letter: a "W" over the
// Whiteboard channel whose inbox row, one column to the left, wears the
// palette emoji. The header now draws the ROW's icon fields, and the app
// record the pane fetches when there is no row.

test('bug h: the discussion header draws the tile the inbox row draws', () => {
  const thread = SCREEN.slice(SCREEN.indexOf('function AppDiscussionThread'));
  const body = thread.slice(0, thread.indexOf('\n}\n'));
  // The row, once, feeding both the #handle and the artwork.
  assert.match(body, /const row = snap\.discussions\.find\(\(item\) => item\.slug === slug\) \|\| null;/);
  assert.match(body, /const handle = row\?\.channel \|\| null;/);
  // The row's own two fields first — the same pair AppChannelRow hands the
  // tile — and the fetched app record when there is no row.
  assert.match(body, /icon_url: row \? row\.iconUrl : \(ready \? context\.iconUrl : null\),/);
  assert.match(body, /icon_emoji: row \? row\.iconEmoji : \(ready \? context\.iconEmoji : null\),/);
  const header = body.slice(body.indexOf('<header className="messages-thread-header">'));
  assert.match(header, /data-icon=\{appIconKind\(iconRecord as never\)\}/);
  assert.match(header, /<AppIconContent app=\{iconRecord as never\} \/>/);
  assert.doesNotMatch(header, /\{ name \} as never/, 'never the name alone again');
  // ...which is what the row itself does, so the two tiles are one recipe.
  const rowFn = SCREEN.slice(SCREEN.indexOf('function AppChannelRow'));
  assert.match(rowFn.slice(0, rowFn.indexOf('\n}\n')),
    /icon_url: discussion\.iconUrl,\s*icon_emoji: discussion\.iconEmoji,/);
});

test('bug h: the discussion context carries the app artwork, for a header with no inbox row', async () => {
  // EXECUTED against the store, with `fetch` stubbed: a discussion opened by
  // address for an app the viewer has no channel row for (a non-member
  // following a link), whose record has an emoji, and one with an uploaded
  // icon — which `/api/apps/:slug` sends as the raw row's `icon_image_id`,
  // so the store spells the platform's own `/app-icons/<id>` address, as
  // src/routes/messages-overview.js does for the row.
  const { navStore } = loadTsx('frontend/src/features/nav/nav-store.js');
  const api = {
    MessagesApiError: class MessagesApiError extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [],
  };
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: { './api': api, '../nav/nav-store.js': { navStore } },
  });
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const APPS = {
    'karaoke-77aa': { slug: 'karaoke-77aa', name: 'Karaoke Night', icon_emoji: '🎤', icon_image_id: null, can_collaborate: false },
    'garden-12ab': { slug: 'garden-12ab', name: 'Pixel Garden', icon_emoji: null, icon_image_id: 31, can_collaborate: true },
  };
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { location: { search: '', hash: '' }, App: { user: { id: 7 } } };
  globalThis.fetch = async (url) => {
    const m = /^\/api\/apps\/([^/?]+)(?:\?manifest=summary)?$/.exec(url);
    if (m && APPS[m[1]]) return { ok: true, json: async () => ({ app: APPS[m[1]] }) };
    if (String(url).startsWith('/api/messages/app-discussions')) return { ok: true, json: async () => ({ discussions: [] }) };
    return { ok: false, json: async () => null };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The snapshot, read the way the pane reads it.
  const context = () => {
    let out = null;
    renderToHtml(createElement(() => { out = store.useMessagesSnapshot().discussionContext; return null; }));
    return out;
  };
  try {
    store.route(null, 'karaoke-77aa');
    await settle(); await settle(); await settle();
    assert.deepEqual({ ...context() }, {
      slug: 'karaoke-77aa', name: 'Karaoke Night', archived: false, readOnly: true, iconUrl: null, iconEmoji: '🎤',
    });
    store.route(null, 'garden-12ab');
    await settle(); await settle(); await settle();
    assert.deepEqual({ ...context() }, {
      slug: 'garden-12ab', name: 'Pixel Garden', archived: false, readOnly: false, iconUrl: '/app-icons/31', iconEmoji: null,
    });
  } finally {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

test('a new account\'s Messages says it is empty: #general is read but never listed here (sign-up test, 19 Oct 2026)', () => {
  // Every account is in #general, so the read always has it, and the list
  // leaves it out: the empty state has to ask the list, or it never shows.
  assert.deepEqual(inbox.buildInbox({ conversations: [{ id: 3, kind: 'channel', lastActivityAt: at('2026-10-19T00:00:00Z') }] }), []);
  assert.match(SCREEN, /\{!snap\.loadingList && !snap\.error && snap\.listLoaded && !inbox\.length\n\s+\? <div className="messages-empty"><h3>\{t\('messages:inbox\.empty\.title'\)\}<\/h3>/);
  assert.doesNotMatch(SCREEN, /!snap\.conversations\.length && !inbox\.length/);
  assert.equal(message('messages:inbox.empty.title'), 'No messages yet');
});


test('the oldest-chats shortcut shows only above the end of a visible overflowing inbox', () => {
  const { showsToEnd } = loadTsx('frontend/src/features/messages/inbox-to-end.tsx');
  assert.equal(showsToEnd({ clientHeight: 500, scrollHeight: 500, scrollTop: 0 }), false);
  assert.equal(showsToEnd({ clientHeight: 0, scrollHeight: 900, scrollTop: 0 }), false);
  assert.equal(showsToEnd({ clientHeight: 500, scrollHeight: 1200, scrollTop: 0 }), true);
  assert.equal(showsToEnd({ clientHeight: 500, scrollHeight: 1200, scrollTop: 580 }), false);
  assert.equal(showsToEnd({ clientHeight: 500, scrollHeight: 1200, scrollTop: 579 }), true);
  assert.match(SCREEN, /<InboxToEnd scroller=\{scrollRef\} \/>/);
  assert.equal(message('messages:inbox.toEnd.label'), 'Oldest chats');
});
