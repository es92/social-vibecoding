'use strict';

// Frontend contract for #488. These assertions deliberately pin the seams
// where a private, React-owned screen meets the classic hash router and REST
// API. The database behavior lives in platform-messaging-*.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = read('public/index.html');
const app = read('public/js/app.js');
const api = read('frontend/src/features/messages/api.ts');
const store = read('frontend/src/features/messages/store.ts');
const screen = read('frontend/src/features/messages/index.tsx');
const composer = read('frontend/src/features/messages/composer.tsx');
const attachmentLimits = read('frontend/src/features/attachments/limits.ts');
const row = read('frontend/src/features/messages/message-row.tsx');
const markdown = read('frontend/src/features/messages/format.tsx');
const platformMarkdown = read('frontend/src/lib/platform-markdown.js');
const dapp = JSON.parse(read('dapp.json'));

test('Messages is a hidden React-owned top-level screen with global navigation', () => {
  assert.match(html, /<main id="messages-screen" class="hidden /);
  // A TAB since #2718, not a menu row. The destination and its address are
  // unchanged; what changed is that it is on screen instead of two taps down
  // inside a sheet you open to choose where to go.
  assert.match(html, /id="platform-tab-messages"[^>]*href="#messages"/);
  // #drawer-messages-badge stays retired, and the count that replaced it is
  // the TAB's. #1431 put an unread number on a header chat bubble and #1443
  // moved it onto the menu row; both made one incoming message light two
  // badges in two colours, and the one it lit sat inside a closed sheet. A
  // tab is visible without opening anything, which is the difference the
  // argument turned on.
  assert.doesNotMatch(html, /drawer-messages-badge/,
    'the retired row tag stays retired');
  assert.match(html, /id="platform-tabs-badge"/, 'the tab is what can carry a count');
  // The bar's order, pinned as a declared check. `+` rather than `~`: the
  // tabs are adjacent siblings. The markup is the desktop rail's order
  // (#6019, 29 Oct 2026; One Home #6361 put AI above Messages and retired
  // Discover's tab): Home, AI, Messages, Communities (key `workshop`), you;
  // app.css lays the phone's five out as Home, Communities, AI, Messages,
  // you. D (18 Oct 2026): Recents (the communities pinned to its top, then
  // your others) sits under the Communities row, drawn only on a desktop.
  // Most hrefs are left out: the runner's selector cap
  // (`MAX_TEST_SELECTOR_LEN`, tests/proposal-tests-manifest.test.js) would
  // clip them, and the render tests pin them.
  assert.ok(dapp.tests.some((entry) => entry.expectSelector
    === '#platform-tabs #platform-tab-home + #platform-tab-ai[href="#homeroom-bot"]'
      + ' + #platform-tab-messages + #platform-tab-workshop[href="#communities"]'
      + ' + #platform-rail-pinned + #platform-rail-communities + #platform-tab-me'),
  'a declared check pins the bar order');
  assert.match(screen, /useVisibilityHiddenClass\(screenRef, 'messages-screen', false\)/);
  // Membership INSIDE the array literal. The previous form,
  // /REACT_SCREEN_IDS:[\s\S]*?'messages-screen'/, matched the id anywhere
  // later in the file — SCREEN_IDS, getElementById('messages-screen'), the
  // route table — and so passed for the whole time the id was missing from
  // this list (#1431 took it out when Messages became a sheet; #1444 made
  // Messages a screen again and put it back everywhere except here). Two
  // owners of one `hidden` class was the result, and six declared checks
  // failed by the timing of whichever visibility publish came last.
  const reactOwned = /REACT_SCREEN_IDS:\s*\[([\s\S]*?)\]/.exec(app);
  assert.ok(reactOwned, 'REACT_SCREEN_IDS is an array literal');
  assert.match(reactOwned[1], /'messages-screen'/,
    'the island owns #messages-screen\'s hidden class, so app.js must publish, not toggle');
  assert.match(app, /parts\[0\] === 'messages'[\s\S]{0,1400}navigateToMessages/);
});

test('an app\'s channel address goes to its project page\'s Discussion tab; only Homeroom\'s archive stays here', () => {
  // #2718 review. The row was listed in this inbox and addressed as
  // `#app/<slug>/dev/chat` — a different SCREEN ROOT — so a row in this list
  // opened a full-window takeover with the app view's own back slot instead
  // of a pane beside the list. Both complaints it drew ("still one pane for
  // apps", "back goes to the workshop") were that one mismatch.
  //
  // #3653: the room is its project page's Discussion tab now, so the address
  // goes there (App._appChatToHub, tests/discussion-in-hub.test.js); the one
  // room still drawn here is Homeroom's archived app chat.
  const routeStart = app.indexOf("if (parts[0] === 'messages')");
  const messagesRoute = app.slice(routeStart, app.indexOf("if (parts[0] === 'topochain')", routeStart));
  assert.match(messagesRoute, /parts\[1\] === 'app' && parts\[2\]/, 'the inbox reads the address');
  // #2387: what follows the slug — a reply thread, a message link — rides
  // along as a third argument (App._messagesExtras).
  assert.match(messagesRoute, /if \(App\._appChatToHub\(parts\[2\], parts\.slice\(3\), hash\)\) return;\s*App\.navigateToMessages\(null, parts\[2\], App\._messagesExtras\(parts\.slice\(3\)\)\)/);
  assert.match(app, /navigateToMessages\(conversationId, appSlug, extras\)/);
  // The hub's record still names the room at this address; the hub's own
  // Discussion row opens the project page's Discussion place, where the
  // room is drawn whole, and links nowhere else.
  assert.match(read('src/routes/apps.js'), /href: `#messages\/app\/\$\{encodeURIComponent\(app\.slug\)\}`,/);
  assert.match(read('frontend/src/features/dev-board/workshop/hub-cards.tsx'),
    /data-ws-channel="preview"\s+data-ws-channel-open=""[\s\S]{0,120}onClick=\{onOpen\}/);
  // ONE THREAD IS OPEN: naming an app clears the conversation and the other
  // way round, so the pane never holds half of each.
  assert.match(store, /const nextSlug = nextId \? null : validSlug\(appSlug\);/);
  // The pane is a HOST for features/group-chat, not a second transcript.
  assert.match(screen, /function AppDiscussionThread/);
  assert.match(screen, /renderGroupChatTab\?\.\(\{ host: el, slug, name, readOnly, archived \}\)/);
  // …and it drops BOTH portals on the way out, the transcript's first.
  assert.match(screen, /unmountTranscript\?\.\(list\)[\s\S]{0,120}unmountGeneralChat\?\.\(el\)/);
  // The list collapses for a discussion exactly as it does for a thread.
  assert.match(screen, /snap\.route\.conversationId \|\| snap\.route\.appSlug \? 'hidden md:flex' : 'flex'/);
});

test('deep links validate ids and route list/thread without a client events socket send', () => {
  const routeStart = app.indexOf("if (parts[0] === 'messages')");
  const messagesRoute = app.slice(routeStart, app.indexOf("if (parts[0] === 'topochain')", routeStart));
  assert.match(messagesRoute, /const conversationId = App\._numericSegment\(parts\[1\]\)/);
  assert.match(messagesRoute, /conversationId != null && conversationId <= 2147483647/,
    'SERIAL conversation ids retain their signed-int32 bound without constraining other hash routes');
  assert.match(messagesRoute, /App\.navigateToMessages\(/);
  assert.match(api, /id <= MAX_ID/);
  assert.match(store, /const target = validId\(conversationId\) \? `#messages\/\$\{conversationId\}` : '#messages'/);
  assert.match(store, /api\.setTyping\(conversationId, typing, threadRootId\)/,
    'typing uses its authenticated HTTP endpoint (31 Oct 2026: naming the thread it is typed in)');
  assert.doesNotMatch(store, /eventsWs.*send|eventsWsSend/,
    'the global event socket remains server-to-client only');
});

test('the conversation list loads only after auth and reconciles on reconnect', () => {
  const initialize = store.slice(store.indexOf('export function initializeMessagesStore()'),
    store.indexOf('\n}', store.indexOf('export function initializeMessagesStore()')) + 2);
  assert.match(initialize, /if \(window\.App\?\.user\) void loadConversations\(\)/,
    'an already-authenticated shell seeds the always-mounted conversation store');
  assert.match(initialize, /else document\.addEventListener\('sv:authed', onAuthed, \{ once: true \}\)/,
    'an anonymous shell waits instead of issuing a session-gated request');
  assert.match(initialize, /document\.removeEventListener\('sv:authed', onAuthed\)/,
    'the auth listener is cleaned up if the island unmounts first');
  const resyncStart = app.indexOf('  resyncCurrentView() {');
  const resync = app.slice(resyncStart, app.indexOf('// #1038:', resyncStart));
  // #3705: `resync` — the list, and the conversation on screen with it.
  assert.match(resync, /window\.UsernodeReact\?\.messages\?\.resync\?\.\(\)/);
  assert.doesNotMatch(resync, /_inMessages[\s\S]*messages\?\.resync/,
    'reconnect refreshes the conversation list even when the Messages screen is closed');
  const storeResync = store.slice(store.indexOf('export async function resync('),
    store.indexOf('\n}', store.indexOf('export async function resync(')));
  assert.match(storeResync, /const reads = \[loadConversations\(true\)\];/,
    'the list is re-read whatever is on screen');
});

test('an invitation resolves metadata before deciding whether history may be fetched', () => {
  const fn = store.slice(store.indexOf('export async function loadThread('),
    store.indexOf('export async function loadOlder('));
  const detailAt = fn.indexOf('await api.getConversation(conversationId, read)');
  const statusAt = fn.indexOf("active.membershipStatus === 'member'");
  const messagesAt = fn.indexOf('await api.listMessages(conversationId, null, read)');
  assert.ok(detailAt > -1 && detailAt < statusAt && statusAt < messagesAt);
  assert.match(screen, /t\('messages:invitation\.invitedBy', \{ username: requesterUser\.username \}\)/);
  assert.match(message('messages:invitation.invitedBy', { username: 'ada' }), /^@ada invited you\. Accepting gives you access to the complete retained conversation history\.$/);
  assert.match(api, /if \(raw === null \|\| \(action === 'decline'/,
    'a declined invitation never normalizes a synthetic id=0 conversation');
  assert.equal(message('messages:invitation.declineAndBlock', { username: 'ada' }), 'Decline & block @ada');
  assert.match(screen, /t\('messages:invitation\.declineAndBlock', \{ username: requesterUser\.username \}\)/,
    'both direct and group invitations expose a pre-accept requester block action');
  const block = screen.slice(screen.indexOf('async function declineAndBlock()'),
    screen.indexOf('  return (', screen.indexOf('async function declineAndBlock()')));
  const apiAt = block.indexOf('await api.setBlock(requesterId, true)');
  const purgeAt = block.indexOf('await finishDirectBlock(conversationId)');
  assert.ok(apiAt > -1 && apiAt < purgeAt,
    'the committed global block/decline is followed immediately by local invitation purge');
});

// #3228: a group invitation names the group, how many people are already in
// it, and the inviter's note; without a note the card says who invited you,
// as before. The optional note field rides both dialogs that invite.
test('a group invitation names the group and carries the inviter\'s note', () => {
  const createDialog = read('frontend/src/features/messages/create-dialog.tsx');
  const membersDialog = read('frontend/src/features/messages/members-dialog.tsx');
  const types = read('frontend/src/features/messages/types.ts');
  assert.match(screen, /t\('messages:invitation\.groupSummary', \{ title: active\.title, count: active\.memberCount \|\| 0 \}\)/);
  assert.match(screen, /t\('messages:invitation\.addedYouWithNote', \{ username: requesterUser\.username, note: active\.inviteNote \}\)/);
  assert.equal(message('messages:invitation.groupSummary', { title: 'Friday demo crew', count: 4 }), 'Friday demo crew · 4 members');
  assert.equal(message('messages:invitation.groupSummary', { title: 'Friday demo crew', count: 1 }), 'Friday demo crew · 1 member');
  assert.equal(message('messages:invitation.addedYouWithNote', { username: 'ada', note: 'Planning the Friday demo' }), '@ada added you: Planning the Friday demo');
  assert.equal(message('messages:invitation.historyNotice'), 'Accepting gives you access to the complete retained conversation history.');
  // Without a note, today's "invited you" sentence stays.
  assert.match(screen, /t\('messages:invitation\.invitedBy', \{ username: requesterUser\.username \}\)/);
  // Both dialogs carry the optional note, capped at 140, through to the API.
  assert.match(createDialog, /t\('messages:create\.inviteNote'\)/);
  assert.match(createDialog, /createGroup\(title\.trim\(\), selected\.map\(\(user\) => user\.id\), note\.trim\(\) \|\| undefined\)/);
  assert.match(membersDialog, /t\('messages:members\.inviteNote'\)/);
  assert.match(membersDialog, /inviteMembers\(selected\.map\(\(user\) => user\.id\), note\.trim\(\) \|\| undefined\)/);
  assert.match(types, /inviteNote\?: string \| null/);
  assert.equal(message('messages:create.inviteNote'), 'Note for the people you invite (optional)');
});

// #5019: scrolling up near the top of a conversation reads the previous page
// in, in place of the button that used to sit at its top. The button returns
// only to retry a failed load.
test('a conversation loads earlier messages on scroll, one page at a time', () => {
  assert.match(screen, /import \{ centreInScroller, isNearBottom, isNearStart, isNearTop, LOAD_NEWER_SLACK_PX, needsMoreHistory, useStickToBottom \} from '\.\/stick-to-bottom';/);
  const thread = screen.slice(screen.indexOf('function ConversationThread('), screen.indexOf('function ThreadActivityRow('));
  assert.ok(thread.length > 0);
  assert.match(thread, /if \(!isNearTop\(el\)\) return;/,
    'the scroll position decides, not a click');
  assert.match(thread, /olderGate\.current = \{ conversationId, nextBefore: snap\.nextBefore, loadingOlder: snap\.loadingOlder, loadingThread: snap\.loadingThread, olderFailed \}/,
    'the scroll listener reads the latest values through a ref, so it attaches once per scroller');
  assert.match(thread, /if \(!gate\.nextBefore \|\| gate\.loadingOlder \|\| gate\.loadingThread \|\| gate\.olderFailed\) return;/,
    'one page at a time, and nothing while loading or after a failure');
  assert.match(thread, /el\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/);
  assert.match(thread, /return \(\) => el\.removeEventListener\('scroll', onScroll\)/,
    'the listener is removed with the conversation');
  assert.match(thread, /if \(!ok\) setOlderFailed\(true\)/,
    'a failed load restores the button as the manual retry');
  assert.match(thread, /useIsomorphicLayoutEffect\(\(\) => \{ setOlderFailed\(false\); \}, \[conversationId, snap\.nextBefore\]\)/,
    'a new conversation, or a new cursor, clears the failure');
  assert.match(thread, /if \(needsMoreHistory\(el\)\) maybeLoadOlder\(\)/,
    'a short thread keeps reading pages in until the screen fills');
  // The row where the button used to be: fixed height, the "Loading…" line
  // while it works, the button only after a failure.
  const olderRow = thread.slice(thread.indexOf('data-load-older=""') - 60);
  assert.ok(olderRow.length > 0);
  assert.match(olderRow, /className="flex h-12 items-center justify-center" data-load-older=""/);
  assert.match(olderRow, /role="status"/);
  assert.match(olderRow, /\{t\('messages:thread\.loadingOlder'\)\}/);
  assert.match(olderRow, /\{t\('messages:thread\.loadEarlier'\)\}/);
  // loadOlder says whether it read a page, and the scroll anchor follows it.
  const loadOlder = store.slice(store.indexOf('export async function loadOlder('), store.indexOf('function validId('));
  assert.match(loadOlder, /Promise<boolean>/);
  assert.match(loadOlder, /return false;/, 'only the failed request says false');
  assert.match(screen, /const ok = await loadOlder\(\);/);
  assert.match(screen, /return ok;/);
});

// #6148: the other two ends read their next page in the same way. At the
// foot of a window a message link opened part-way back (#2387), scrolling
// down reads the newer page in, in place of "Load newer messages"; at the top
// of a thread's replies, scrolling up reads the earlier page in, in place of
// "Load earlier replies". Each button returns only to retry a failed load.
test('#6148: a linked window loads newer messages as the reader scrolls to its foot, one page at a time', () => {
  const thread = screen.slice(screen.indexOf('function ConversationThread('), screen.indexOf('function ThreadActivityRow('));
  const loader = thread.slice(thread.indexOf('function maybeLoadNewer('), thread.indexOf('useIsomorphicLayoutEffect(', thread.indexOf('function maybeLoadNewer(')));
  assert.ok(loader.length > 0, 'maybeLoadNewer sits beside maybeLoadOlder');
  assert.ok(thread.indexOf('function maybeLoadOlder(') < thread.indexOf('function maybeLoadNewer('));
  assert.match(thread, /newerGate\.current = \{ nextAfter: snap\.nextAfter, loadingOlder: snap\.loadingOlder, loadingThread: snap\.loadingThread, newerFailed \}/,
    'the latest values reach the listener through a ref, as olderGate does');
  // Scrolling to the bottom reads a page; a second scroll while it loads
  // does not (the store's one flag for a page at either end), nor any after
  // a failure, nor any once the window has reached the present.
  assert.match(loader, /if \(!gate\.nextAfter \|\| gate\.loadingOlder \|\| gate\.loadingThread \|\| gate\.newerFailed\) return;/);
  assert.match(loader, /if \(!isNearBottom\(el, LOAD_NEWER_SLACK_PX\)\) return;/, 'the scroll position decides, not a click');
  assert.match(loader, /void loadNewer\(\)\.then\(\(ok\) => \{ if \(!ok\) setNewerFailed\(true\); \}\);/,
    'a failed load restores the button as the manual retry');
  // What is on screen stays: the page lands below it, and nothing here
  // scrolls or pins. useStickToBottom's atPresent keeps the reader's own
  // scrolls from pinning until nextAfter goes, and then it follows again.
  assert.doesNotMatch(loader, /pinned\.current|scrollTop/);
  assert.match(thread, /const pinned = useStickToBottom\(scroller, !snap\.nextAfter\);/);
  // From the same listener as the top's, attached once per scroller.
  assert.match(thread, /const onScroll = \(\) => \{ maybeLoadOlder\(\); maybeLoadNewer\(\); \};\s*el\.addEventListener\('scroll', onScroll, \{ passive: true \}\);\s*return \(\) => el\.removeEventListener\('scroll', onScroll\);/);
  assert.match(thread, /useIsomorphicLayoutEffect\(\(\) => \{ setNewerFailed\(false\); \}, \[conversationId, snap\.nextAfter\]\);/,
    'a new conversation, or a new cursor, clears the failure');
  // A window too short to scroll reads its next page without being asked;
  // a hidden one (no height, under a thread on a phone) is not short.
  assert.match(thread, /if \(!el \|\| !el\.clientHeight\) return;\s*if \(needsMoreHistory\(el\)\) maybeLoadNewer\(\);\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\}, \[snap\.messages, snap\.nextAfter, snap\.loadingOlder\]\);/);
  // The foot: "Loading…" while a page loads, the retry only after a
  // failure, and Jump to present, quiet, always.
  const foot = thread.slice(thread.indexOf('<div className="messages-newer" data-load-newer="">'), thread.indexOf('</div>', thread.indexOf('<div className="messages-newer" data-load-newer="">')));
  assert.ok(foot.length > 0);
  assert.match(foot, /\{snap\.loadingOlder\s*\? <span role="status" className="text-\[13px\] text-zinc-500 dark:text-zinc-400">\{t\('messages:thread\.loadingNewer'\)\}<\/span>\s*: newerFailed\s*\? <button type="button" onClick=\{\(\) => \{ setNewerFailed\(false\); void loadNewer\(\)\.then\(\(ok\) => \{ if \(!ok\) setNewerFailed\(true\); \}\); \}\} className="messages-load-older">\{t\('messages:thread\.loadNewer'\)\}<\/button>\s*: null\}/);
  assert.match(foot, /<button type="button" className="messages-jump-present" onClick=\{\(\) => \{ pinned\.current = true; jumpToPresent\(\); \}\}>\{t\('messages:thread\.jumpToPresent'\)\}<\/button>/);
  assert.doesNotMatch(thread, /disabled=\{snap\.loadingOlder\} onClick=\{\(\) => void loadNewer\(\)\}/,
    'no button to press for every page');
  assert.equal(message('messages:thread.loadingNewer'), 'Loading…');
  assert.equal(message('messages:thread.loadNewer'), 'Load newer messages');
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-newer \{ display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 8px 0; \}/,
    'the row keeps its height whatever it holds');
  assert.match(css, /\.messages-jump-present \{[^}]*color: var\(--text-muted\);[^}]*background: transparent;/, 'muted words on no fill');
  // loadNewer says whether it read a page, as loadOlder does.
  const loadNewer = store.slice(store.indexOf('export async function loadNewer('), store.indexOf('export function jumpToPresent('));
  assert.match(loadNewer, /Promise<boolean>/);
  assert.match(loadNewer, /if \(!conversationId \|\| !state\.nextAfter \|\| state\.loadingOlder\) return true;/);
  assert.match(loadNewer, /return true;\s*\} catch \(error\) \{[\s\S]*?return false;\s*\}\s*\}/, 'only the failed request says false');
});

test('#6148: a thread loads earlier replies as the reader scrolls to their top, keeping what is on screen in place', () => {
  const panel = screen.slice(screen.indexOf('function ReplyThreadPanel('), screen.indexOf('function AppReplyThreadPanel('));
  assert.ok(panel.length > 1000);
  const loader = panel.slice(panel.indexOf('function maybeLoadEarlierReplies('), panel.indexOf('useIsomorphicLayoutEffect(', panel.indexOf('function maybeLoadEarlierReplies(')));
  assert.ok(loader.length > 0);
  assert.match(panel, /earlierGate\.current = \{ nextBefore: thread\?\.nextBefore \|\| null, loading: !!thread\?\.loading, earlierFailed \}/);
  assert.match(loader, /if \(!gate\.nextBefore \|\| gate\.loading \|\| gate\.earlierFailed\) return;/,
    'one page at a time, and nothing while loading or after a failure');
  // The top of the replies: their row under the message the thread hangs
  // off, measured as the row, not as the scroller's own top.
  assert.match(loader, /const start = earlierRow\.current;\s*if \(!\(start \? isNearStart\(el, start\) : isNearTop\(el\)\)\) return;/);
  assert.match(loader, /void earlierReplies\(\)\.then\(\(ok\) => \{ if \(!ok\) setEarlierFailed\(true\); \}\);/);
  // As older() keeps it: the height before the page, the difference after.
  const keep = panel.slice(panel.indexOf('async function earlierReplies('), panel.indexOf('return ok;', panel.indexOf('async function earlierReplies(')));
  assert.match(keep, /if \(el\) earlierScroll\.current = el\.scrollHeight;\s*const ok = await loadOlderReplies\(\);\s*requestAnimationFrame\(\(\) => \{\s*if \(el && earlierScroll\.current !== null\) el\.scrollTop \+= el\.scrollHeight - earlierScroll\.current;\s*earlierScroll\.current = null;\s*\}\);/);
  assert.match(panel, /useIsomorphicLayoutEffect\(\(\) => \{ earlierScroll\.current = null; \}, \[conversationId, rootId\]\);/,
    'another thread forgets a page still on its way');
  assert.match(panel, /const onScroll = \(\) => maybeLoadEarlierReplies\(\);\s*el\.addEventListener\('scroll', onScroll, \{ passive: true \}\);\s*return \(\) => el\.removeEventListener\('scroll', onScroll\);\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\}, \[conversationId, rootId\]\);/);
  assert.match(panel, /useIsomorphicLayoutEffect\(\(\) => \{ setEarlierFailed\(false\); \}, \[conversationId, rootId, thread\?\.nextBefore\]\);/);
  assert.match(panel, /if \(!el \|\| !el\.clientHeight\) return;\s*if \(needsMoreHistory\(el\)\) maybeLoadEarlierReplies\(\);\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\}, \[thread\?\.messages\.length, thread\?\.nextBefore, thread\?\.loading\]\);/,
    'a thread too short to scroll reads its earlier page without being asked');
  // The hooks run before the pane's early returns (hook order).
  assert.ok(panel.indexOf('function maybeLoadEarlierReplies(') < panel.indexOf('if (!conversationId || !rootId) return null;'));
  // The row: its height held, "Loading…" while a page loads, the retry only
  // after a failure; the discussion's own link beside it as before.
  const row = panel.slice(panel.indexOf('<div ref={earlierRow}'), panel.indexOf('</div>', panel.indexOf('<div ref={earlierRow}')));
  assert.match(row, /className="flex min-h-12 flex-wrap items-center justify-center gap-x-3 gap-y-1 py-2" data-load-earlier-replies=""/);
  assert.match(row, /\? thread\.loading\s*\? <span role="status" className="text-\[13px\] text-zinc-500 dark:text-zinc-400">\{t\('messages:replies\.loadingEarlier'\)\}<\/span>\s*: earlierFailed\s*\? <button type="button" onClick=\{\(\) => \{ setEarlierFailed\(false\); void earlierReplies\(\)\.then\(\(ok\) => \{ if \(!ok\) setEarlierFailed\(true\); \}\); \}\} className="messages-load-older">\{t\('messages:replies\.loadEarlier'\)\}<\/button>\s*: null/);
  assert.match(row, /discussion\?\.more \? <a className="messages-load-older" href=\{issueRefHref\(discussion\.appSlug, String\(discussion\.issueNumber\)\)\}>\{t\('messages:replies\.discussion\.more'\)\}<\/a> : null/);
  assert.doesNotMatch(panel, /disabled=\{thread\.loading\} onClick=\{\(\) => void loadOlderReplies\(\)\}/,
    'no button to press for every page');
  assert.equal(message('messages:replies.loadingEarlier'), 'Loading…');
  assert.equal(message('messages:replies.loadEarlier'), 'Load earlier replies');
  // loadOlderReplies says whether it read a page; a failed page leaves the
  // replies drawn, with no error standing in their place.
  const loadOlderReplies = store.slice(store.indexOf('export async function loadOlderReplies('), store.indexOf('export function setListCollapsed('));
  assert.match(loadOlderReplies, /Promise<boolean>/);
  assert.match(loadOlderReplies, /if \(!thread \|\| !thread\.nextBefore \|\| thread\.loading\) return true;/);
  const failed = loadOlderReplies.slice(loadOlderReplies.indexOf('} catch'));
  assert.match(failed, /publish\(\{ thread: \{ \.\.\.now, loading: false \} \}\);\s*return false;/);
  assert.doesNotMatch(failed, /error:/);
});

test('message creation realtime carries ids and refetches viewer-authorized REST data', () => {
  for (const type of [
    'conversation_message_created', 'conversation_message_updated',
    'conversation_reaction_updated', 'conversation_read',
    'conversation_membership_changed', 'conversation_typing',
  ]) {
    assert.match(app, new RegExp(`case '${type}'`));
  }
  // #2387: created and updated share one block (a thread reply re-reads its
  // thread as well as the conversation), so the slice runs to the next case.
  const created = store.slice(store.indexOf("case 'conversation_message_created'"),
    store.indexOf("case 'conversation_reaction_updated'"));
  assert.match(created, /loadThread\(conversationId, true\)/);
  assert.doesNotMatch(created, /normalizeMessage\(event\.message/,
    'WS must never trust a sender-hydrated private object card');
  assert.match(store, /filter\(\(item\) => item\.clientKey !== key && item\.id !== message\.id\)/,
    'HTTP completion removes both the local row and a raced-in server row');
  const reaction = store.slice(store.indexOf("case 'conversation_reaction_updated'"),
    store.indexOf("case 'conversation_read'"));
  assert.match(reaction, /loadThread\(conversationId, true\)/);
  assert.doesNotMatch(reaction, /event\.reactions|normalizeMessage/,
    'id-only reaction events rehydrate under current viewer access');
  const typing = store.slice(store.indexOf("case 'conversation_typing'"),
    store.indexOf('export function typingUsers'));
  assert.match(typing, /active\.members\.find/);
  assert.doesNotMatch(typing, /event\.username/,
    'id-only typing events resolve names from the authorized active roster');
});

test('attachment ids remain opaque hex and a denied preview stays null', () => {
  assert.match(api, /\^\[a-f0-9\]\{32\}\$/);
  assert.match(api, /attachment_ids = input\.attachmentIds/);
  assert.match(api, /rawViewUrl === null \? null/);
  assert.match(row, /html && attachment\.viewUrl \?/,
    'the UI offers preview only when the backend did');
});

test('composer and moderation payloads match the backend contracts', () => {
  // #6256: the cap and the per-type ceiling live once, in the module both the
  // conversation composer and the blank thread's composer read.
  assert.match(attachmentLimits, /const MAX_ATTACHMENTS = 4/);
  assert.match(composer, /import \{ MAX_ATTACHMENTS, stageFiles \} from '\.\.\/attachments\/limits'/);
  assert.match(composer, /slice\(0, 8000\)/);
  const shareHandler = composer.slice(composer.indexOf('const onShare ='),
    composer.indexOf("window.addEventListener('usernode:messages-object-selected'"));
  assert.match(shareHandler, /if \(!conversationId\) return/,
    'a bare Messages screen leaves an external share pending for destination selection');
  const consumeAt = shareHandler.indexOf('takePendingShare()');
  const openAt = shareHandler.indexOf('messagesShare?.open');
  assert.ok(consumeAt > -1 && consumeAt < openAt,
    'a synchronously delivered share clears its fallback before opening');
  assert.match(composer, /if \(conversationId\) \{[\s\S]{0,120}takePendingShare\(\)/,
    'selecting or creating a destination consumes the one-shot on route change');
  // The pending-share effect's own dependencies (this used to match the
  // typing cleanup's `[conversationId]` instead, which now names the thread).
  assert.match(composer, /window\.removeEventListener\('usernode:messages-share', onShare\);\s*\};\s*\}, \[conversationId, inThread\]\);/,
    'the pending-share effect follows destination changes');
  const share = store.slice(store.indexOf('export async function share('),
    store.indexOf('export function takePendingShare'));
  assert.match(share, /if \(conversationId\) \{[\s\S]{0,180}dispatchEvent/,
    'current-conversation shares remain immediate without consuming bare-list intent');
  const close = store.slice(store.indexOf('export function close()'),
    store.indexOf('export function isOpen()'));
  assert.match(close, /pendingShare = undefined/,
    'leaving Messages cancels an unplaced external share');
  assert.ok(composer.includes("match(/(?:^|\\s)@([^\\s@]*)$/)"));
  assert.ok(composer.includes("replace(/@([^\\s@]*)$/"),
    'mention completion and insertion support hyphenated and other valid usernames');
  assert.match(api, /query\.trim\(\)\.slice\(0, 255\)[\s\S]{0,80}scope=messages/,
    'recipient search excludes users blocked in either direction');
  const sharedReport = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dialogs/report.tsx'), 'utf8');
  assert.match(row, /openReport\(\{ targetType: 'conversation_message'/);
  for (const reason of ['harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other']) assert.ok(sharedReport.includes(`['${reason}',`));
  assert.match(sharedReport, /maxLength=\{1000\}/);
  assert.match(sharedReport, /fetch\('\/api\/reports'/);

});

test('the composer\'s chip is only an item the person chose: nothing attaches one for them', () => {
  // #6212 kept the Homeroom bot tab's list attaching what a row opened to
  // Main Chat's box, apart from an item the person chose. 14 Nov 2026: Main
  // Chat is gone, so nothing attaches for the person: no source rides on the
  // event, no clear event takes a chip off, and Ask for changes carries its
  // change into a new chat's box (new-thread.tsx,
  // tests/ask-for-changes-attach.test.js).
  assert.match(composer, /const \[object, setObject\] = useState<StagedObject \| null>\(null\);/);
  assert.match(composer, /const \{ conversationId: to, \.\.\.object \} = detail;\n\s+if \(to != null && to !== conversationId\) return;\n\s+setObject\(object\); inputRef\.current\?\.focus\(\);/,
    'the conversation it is addressed to never rides along as part of the item');
  assert.doesNotMatch(composer, /objectFrom|objectRef|setChip|source === 'list'|messages-object-cleared|setPrompt|focusWanted/);
  // Sending, changing scope and × take the chip off.
  assert.match(composer, /setValue\(''\); setAttachments\(\[\]\); setObject\(null\);/, 'sending');
  assert.match(composer, /setValue\(draftFor\(scope\)\); setAttachments\(draftAttachmentsFor\(scope\)\); setObject\(null\);/);
  assert.match(composer, /onClick=\{\(\) => setObject\(null\)\} aria-label=\{t\('messages:composer\.removeSharedItem'\)\}/);
  // A request's page opened from a bot message attaches nothing either.
  assert.doesNotMatch(read('frontend/src/features/messages/request-page.ts'), /messages-object-selected|source: 'list'/);
  assert.doesNotMatch(read('frontend/src/features/ai/index.tsx'), /messages-object-selected|messages-object-cleared/);
});

test('#6249: attached files are kept with the draft they were attached in', () => {
  assert.match(store, /export function draftAttachmentsFor\(scope: ComposerScope\): MessageAttachment\[\]/);
  assert.match(store, /export function setDraftAttachments\(scope: ComposerScope, items: MessageAttachment\[\]\): void/);
  assert.match(store, /`usernode:messages-draft-attachments:\$\{scope\}`/, 'one saved list per composer scope');
  // A file Homeroom has already cleaned up (24 hours) is never drawn again.
  assert.match(store, /export const DRAFT_ATTACHMENT_MAX_AGE_MS = 23 \* 60 \* 60 \* 1000;/);
  assert.match(store, /if \(now - savedAt > DRAFT_ATTACHMENT_MAX_AGE_MS\) continue;/);
  assert.match(store, /if \(read\.dropped\) writeDraftAttachments\(scope, saved\);/,
    'the key is rewritten once an entry has aged out');
  // Sending clears the saved files beside the saved words.
  assert.match(store, /setDraft\(scope, ''\);\s+setDraftAttachments\(scope, \[\]\);/);
  // An answer tapped on a bot question does not wipe the person's files.
  assert.match(store, /const files = draftAttachmentsFor\(scope\);[\s\S]{0,400}if \(files\.length\) setDraftAttachments\(scope, files\);/);
  // The composer restores them, saves on add against the scope it started in,
  // and saves on ×.
  assert.match(composer, /setValue\(draftFor\(scope\)\); setAttachments\(draftAttachmentsFor\(scope\)\);/);
  assert.match(composer, /const startScope = scopeRef\.current;/);
  assert.match(composer, /updateAttachments\(startScope, \(items\) => \[\.\.\.items, attachment\]\);/);
  assert.match(composer, /updateAttachments\(scope, \(items\) => items\.filter\(\(candidate\) => candidate\.id !== item\.id\)\)/);
  assert.match(composer, /setDraftAttachments\(target, next\);/);
});

test('blocking and access-revocation purge an active direct thread locally', () => {
  assert.match(screen, /await setUserBlocked\(peer\.id, true\)/);
  assert.match(store, /await api\.setBlock\(userId, blocked\)/);
  assert.match(store, /await finishDirectBlock\(active\.id\)/);
  const purge = store.slice(store.indexOf('export async function finishDirectBlock('),
    store.indexOf('export function draftFor('));
  assert.match(purge, /active: null/);
  assert.match(purge, /messages: \[\]/);
  assert.match(purge, /open\(null\)/);
  assert.match(purge, /await loadConversations\(true\)/);
  const list = store.slice(store.indexOf('export async function loadConversations('),
    store.indexOf('export async function loadThread('));
  assert.match(list, /if \(state\.loadingList && !force\) return/,
    'forced post-revocation refresh supersedes an in-flight stale list');
  assert.match(list, /const request = \+\+listRequest/);
  assert.match(list, /if \(request !== listRequest\) return/,
    'the stale request token cannot republish a blocked conversation');
  const membership = store.slice(store.indexOf("case 'conversation_membership_changed'"),
    store.indexOf("case 'conversation_typing'"));
  assert.match(membership, /refreshActiveAfterMembershipChange\(conversationId\)/);
  assert.match(store, /refreshActiveAfterMembershipChange[\s\S]{0,500}finishDirectBlock\(conversationId\)/,
    'a remote removal/block 404 follows the same purge-and-list path');
});

test('message Markdown delegates only to the established DOMPurify allowlist', () => {
  assert.match(markdown, /window\.PlatformMarkdown\.render\(content, \{ breaks: true \}\)/);
  // `out`, because the sanitized html is cached before it is returned.
  assert.match(platformMarkdown, /const out = DOMPurify\.sanitize\(html, \{/);
  assert.match(platformMarkdown, /ALLOW_DATA_ATTR: false/);
  assert.match(platformMarkdown, /ALLOWED_TAGS:/);
});

test('staging demo stays server-authored while the client forwards demo=1', () => {
  assert.match(api, /new URLSearchParams\(window\.location\.search\)\.get\('demo'\) !== '1'/);
  assert.doesNotMatch(store, /demoConversations|demoMessages|mockConversation/,
    'production client code never invents private conversation data');
});
