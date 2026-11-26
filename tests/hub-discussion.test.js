'use strict';

// The hub's Discussion (owner, 26 Nov 2026): a project's #general drawn on
// its hub as posts with replies, the hub in two columns around it.
//
//   frontend/src/features/dev-board/workshop/discussion-feed.ts  the rule and the reads
//   frontend/src/features/dev-board/workshop/hub-discussion.tsx  the card, the phone's card, the page
//   src/services/discussion.js                                    what was said before Discussion
//
// A post is a message in #general's main stream and its replies are the
// reply thread under it; with more than eight messages from before
// Discussion, those are one "Earlier in #general" post.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FEED = 'frontend/src/features/dev-board/workshop/discussion-feed.ts';
const CARD = 'frontend/src/features/dev-board/workshop/hub-discussion.tsx';
const feed = loadTsx(FEED);

const SINCE = '2026-11-26T12:00:00.000Z';
const said = (id, over = {}) => ({
  id,
  who: { id: 1, username: 'priya' },
  content: `message ${id}`,
  at: over.at || new Date(Date.parse(SINCE) + id * 60000).toISOString(),
  deleted: false,
  reactions: [],
  files: 0,
  rootId: null,
  replyCount: 0,
  lastReplyAt: null,
  ...over,
});
const before = (id, over = {}) => said(id, { at: new Date(Date.parse(SINCE) - (100 - id) * 3600000).toISOString(), ...over });

test('the history from before Discussion folds into one post above eight messages, and only then', () => {
  const summary = (count, foldAt) => ({ since: SINCE, fold_at: foldAt, earlier: { count, from: '2026-10-02T00:00:00Z', to: '2026-11-24T00:00:00Z', last_id: 40 } });
  assert.equal(feed.EARLIER_FOLD_AT, 8, 'the owner\'s "say 8"');
  assert.equal(feed.earlierFold(summary(8)), null, 'eight are eight posts');
  assert.deepEqual(feed.earlierFold(summary(9)), { count: 9, from: '2026-10-02T00:00:00Z', to: '2026-11-24T00:00:00Z', lastId: 40, since: SINCE });
  assert.equal(feed.earlierFold(summary(9, 12)), null, 'the server\'s number wins');
  assert.equal(feed.earlierFold({ since: SINCE, earlier: null }), null);
  assert.equal(feed.earlierFold({ since: null, earlier: { count: 50, last_id: 4 } }), null, 'no marker, no fold');
  assert.equal(feed.earlierFold(null), null);
  const server = require('../src/services/discussion');
  assert.equal(server.EARLIER_FOLD_AT, feed.EARLIER_FOLD_AT, 'the server and the card count to the same number');
});

test('posts are main-stream messages, each with its replies under it, oldest first', () => {
  const items = feed.assemble([
    said(10, { replyCount: 2 }),
    said(12, { rootId: 10, who: { id: 2, username: 'dev' } }),
    said(11, { rootId: 10, who: { id: 3, username: 'ana' } }),
    said(13),
    said(14, { rootId: 99 }),
    said(11, { rootId: 10, who: { id: 3, username: 'ana' }, content: 'edited' }),
  ], null);
  assert.equal(items.length, 2, 'a reply whose post was not read waits for it');
  const post = items.find((i) => i.root.id === 10);
  assert.deepEqual(post.replies.map((r) => r.id), [11, 12]);
  assert.equal(post.replies[0].content, 'edited', 'a later read of one message wins');
  assert.equal(post.replyCount, 2);
  assert.equal(post.activityAt, said(12).at, 'its last reply is its activity');
});

test('with the fold, old messages and what is written into it since are the Earlier post\'s replies', () => {
  const fold = { count: 12, from: '2026-10-02T00:00:00Z', to: '2026-11-24T00:00:00Z', lastId: 40, since: SINCE };
  const items = feed.assemble([
    before(38), before(39, { replyCount: 3 }), before(40, { replyCount: 2 }),
    before(41, { rootId: 39 }),
    before(42, { rootId: 40 }),
    said(50, { rootId: 40 }),
    said(51),
  ], fold, true);
  const earlier = items.find((i) => i.kind === 'earlier');
  assert.deepEqual(earlier.replies.map((r) => r.id), [38, 39, 40, 50],
    'the old messages, then the reply written into it since; an old reply stays in its old thread');
  assert.equal(earlier.replyCount, 13, 'twelve old messages and one reply since');
  assert.equal(earlier.olderToRead, true);
  assert.deepEqual(items.filter((i) => i.kind === 'post').map((i) => i.root.id), [51]);
});

test('Newest is the most recent activity; Most replies the busiest; the Earlier post is never newer than a post since', () => {
  const a = { kind: 'post', key: 'a', root: said(1), replies: [], replyCount: 5, activityAt: '2026-11-26T13:00:00Z' };
  const b = { kind: 'post', key: 'b', root: said(2), replies: [], replyCount: 0, activityAt: '2026-11-26T14:00:00Z' };
  const e = { kind: 'earlier', key: 'earlier', replies: [], replyCount: 214, activityAt: '2026-11-26T14:00:00Z' };
  assert.deepEqual(feed.sortItems([a, e, b], 'newest').map((i) => i.key), ['b', 'earlier', 'a']);
  assert.deepEqual(feed.sortItems([a, b, e], 'replies').map((i) => i.key), ['earlier', 'a', 'b']);
});

test('a post is new to the viewer past their reading, unless it is theirs; the Earlier post never is', () => {
  const post = (id, who = 'dev') => ({ kind: 'post', key: `p${id}`, root: said(id, { who: { id: 2, username: who } }), replies: [], replyCount: 0, activityAt: SINCE });
  assert.equal(feed.isNewTo(post(10), 9, 'priya'), true);
  assert.equal(feed.isNewTo(post(10), 10, 'priya'), false);
  assert.equal(feed.isNewTo(post(10, 'priya'), 9, 'priya'), false, 'your own post is not news to you');
  assert.equal(feed.isNewTo(post(10), null, 'priya'), false, 'no reading position, nothing new');
  assert.equal(feed.isNewTo({ kind: 'earlier', replies: [said(50)] }, 9, 'priya'), false);
});

test('a post shows its newest three replies and how many more there are', () => {
  const item = { kind: 'post', replies: [said(1), said(2), said(3), said(4)], replyCount: 6 };
  const closed = feed.shownReplies(item, false);
  assert.deepEqual(closed.shown.map((r) => r.id), [2, 3, 4]);
  assert.equal(closed.hidden, 3);
  assert.equal(feed.shownReplies(item, true).hidden, 2, 'opened: all read, the rest still in the thread');
  assert.equal(feed.REPLIES_SHOWN, 3);
});

test('a reaction is drawn at once: added, counted up, taken back', () => {
  const list = [{ emoji: '👍', count: 2, reacted: false, users: ['dev', 'ana'] }];
  const on = feed.toggledReactions(list, '👍', 'priya');
  assert.deepEqual(on, [{ emoji: '👍', count: 3, reacted: true, users: ['dev', 'ana', 'priya'] }]);
  assert.deepEqual(feed.toggledReactions(on, '👍', 'priya'), list);
  assert.deepEqual(feed.toggledReactions([{ emoji: '🎉', count: 1, reacted: true, users: ['priya'] }], '🎉', 'priya'), [], 'the last one goes');
  assert.deepEqual(feed.toggledReactions([], '🙏', 'priya'), [{ emoji: '🙏', count: 1, reacted: true, users: ['priya'] }]);
});

test('an app channel\'s rows and a Messages room\'s messages are read into one shape', () => {
  const row = {
    id: 7, user_id: 3, username: 'ana', content: 'hi', msg_type: 'message', thread_type: null, thread_ref: null,
    created_at: SINCE, deleted: false, reactions: [{ emoji: '👍', count: 2, users: ['dev', 'priya'] }],
    thread: { reply_count: 4, last_reply_at: '2026-11-26T13:00:00Z' },
  };
  const app = feed.fromAppRow(row, 'priya');
  assert.equal(app.replyCount, 4);
  assert.equal(app.rootId, null);
  assert.equal(app.reactions[0].reacted, true, 'the viewer is one of its people');
  assert.equal(feed.fromAppRow({ ...row, thread_type: 'message', thread_ref: 3 }, null).rootId, 3);
  assert.equal(feed.fromAppRow({ ...row, thread_type: 'issue', thread_ref: 3 }, null), null, 'a request\'s thread is not #general');
  assert.equal(feed.fromAppRow({ ...row, thread_type: 'category', thread_ref: 3 }, null), null, 'nor is a topic\'s');
  assert.equal(feed.fromAppRow({ ...row, msg_type: 'system' }, null), null, 'nor a platform line');
  const conv = feed.fromConversationMessage({
    id: 8, conversationId: 1, sender: { id: 4, username: 'jo' }, content: 'yo', createdAt: SINCE,
    reactions: [], attachments: [], objects: [], threadRootId: null,
    thread: { replyCount: 2, lastReplyAt: SINCE, participants: [] },
  });
  assert.equal(conv.replyCount, 2);
  assert.equal(conv.who.username, 'jo');
  assert.equal(feed.fromConversationMessage({ id: 9, system: true, sender: null, reactions: [], attachments: [] }), null);
});

test('the card draws its frame first and reads in effects; no channel, no card', () => {
  const { DiscussionCard } = loadTsx(CARD);
  const data = (channel) => ({ slug: 'book-club', is_member: true, channel });
  assert.equal(renderToHtml(createElement(DiscussionCard, { slug: 'book-club', name: 'Book Club', data: data(null), mode: 'full' })), '');
  const channel = { recent: [], unread_count: 0, href: '#messages/app/book-club', handle: null, discussion: { since: SINCE, earlier: null } };
  const html = renderToHtml(createElement(DiscussionCard, { slug: 'book-club', name: 'Book Club', data: data(channel), mode: 'full' }));
  assert.match(html, /^<section class="dev-ws-hub-section dev-ws-hub-discussion" data-ws-hub-discussion="full"/);
  assert.match(html, />Discussion<\/h2><p class="dev-ws-hub-discussion-about">Posts and replies from everyone in Book Club<\/p>/);
  assert.match(html, /<form class="dh-composer dh-composer-post" data-ws-discussion-compose="post">[\s\S]*placeholder="Start a post…"/);
  assert.match(html, /data-ws-discussion-sort="newest"[\s\S]*Newest[\s\S]*Most replies/);
  assert.match(html, /data-ws-discussion-loading=""/, 'its rows hold their place while it reads');
  const preview = renderToHtml(createElement(DiscussionCard, { slug: 'book-club', name: 'Book Club', data: data(channel), mode: 'preview' }));
  assert.match(preview, /data-ws-hub-discussion="preview"/);
  assert.match(preview, /data-ws-discussion-open=""/, 'the phone\'s card is a door to the page');
  assert.match(preview, /data-ws-discussion-start-door=""/);
  assert.doesNotMatch(preview, /<textarea/, 'and writes nothing itself');
  // The page is a place (part 2): its own heading, and "Open as chat" at its far end.
  const page = renderToHtml(createElement(DiscussionCard, { slug: 'book-club', name: 'Book Club', data: data(channel), mode: 'page', onChat: () => {} }));
  assert.match(page, /^<div class="dev-ws-discussion-page" data-ws-discussion-page=""><section class="dev-ws-hub-section dev-ws-hub-discussion" data-ws-hub-discussion="page"/);
  assert.match(page, /<h2 id="[^"]+" class="dev-ws-hub-discussion-title">Discussion<\/h2><p class="dev-ws-hub-discussion-about">Posts and replies from everyone in Book Club<\/p><button type="button" class="dh-as-chat" data-ws-discussion-as-chat="">[\s\S]*?Open as chat<\/button><\/div>/);
  assert.doesNotMatch(page, /data-ws-pagehead/, 'no way back of its own: the bar and the list say where it is');
});

test('reactions and replies are the platform\'s own: the hover bar, the long-press sheet, Enter sends', () => {
  const src = read(CARD);
  assert.match(src, /import \{ MessageActionBar \} from '\.\.\/\.\.\/message-actions\/action-bar';/);
  assert.match(src, /import \{ MessageActionSheet, useLongPress \} from '\.\.\/\.\.\/message-actions\/action-sheet';/);
  assert.match(src, /import \{ enterSends, isTouchInput \} from '\.\.\/\.\.\/\.\.\/lib\/enter-sends';/);
  assert.doesNotMatch(src, /rx-add|data-ws-discussion-add-reaction/, 'no always-visible add-reaction button');
  // Homeroom's own #general is a Messages room; any other project's is its app chat.
  assert.match(read(FEED), /messagesApi\.toggleReaction\(conversationId, messageId, emoji, on\)/);
  assert.match(read(FEED), /\$\{base\}\/\$\{messageId\}\/reactions/);
});

test('For you has no #general row where the hub draws the Discussion', () => {
  const hub = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const props = (over) => ({
    slug: 'garden', queue: [], mine: { viewer: true }, alone: false, unclaimed: 0, canPost: true,
    data: { slug: 'garden', is_member: true, channel: { recent: [], unread_count: 0, href: '#messages/app/garden', handle: null } },
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, ...over,
  });
  assert.match(renderToHtml(createElement(hub.ForYouCard, props({}))), /data-ws-channel="preview"/);
  const here = renderToHtml(createElement(hub.ForYouCard, props({ discussionHere: true })));
  assert.doesNotMatch(here, /data-ws-channel/);
  assert.match(here, /data-ws-workshop-row/, 'Needs you and the Workshop stay');
});

test('the hub mounts the card beside its thin column, and the phone\'s card opens the Discussion place', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(lander, /<DiscussionCard slug=\{slug\} name=\{projectName\} data=\{community\} mode="full" \/>/);
  assert.match(lander, /<DiscussionCard slug=\{slug\} name=\{projectName\} data=\{community\} mode="preview" onOpenPage=\{\(\) => openTab\('posts'\)\} \/>/);
  // Part 2: the place draws the page, "Open as chat" turns to #general's chat,
  // and a link the posts cannot show goes on there in place of this entry.
  const place = lander.slice(lander.indexOf("{tab === 'posts' && slug && community ? (community.channel ? ("), lander.indexOf('{isChannelPlace(tab) ? ('));
  assert.match(place, /mode="page"\s+onChat=\{\(\) => openTab\('discussion'\)\}/);
  assert.match(place, /callAppView\('_stashDiscussionTarget', slug, \{ \.\.\.target, asChat: true \}\);\s*setTab\('discussion'\);\s*callAppView\('_setWorkshopTab', 'discussion', slug\);\s*callAppView\('_stampWorkshopTab', slug, 'discussion'\);/);
  assert.match(place, /<ProjectDiscussion slug=\{slug\}[^>]*channel=\{null\}/, 'a viewer the record gives no channel gets the chat\'s own answer');
  const places = loadTsx('frontend/src/features/dev-board/workshop/places.ts');
  assert.equal(places.isPlaceKey('posts'), true);
  assert.equal(places.litPlace('posts'), 'posts');
});

// Part 2: a link to a #general message lands on the Discussion, which opens
// the post it is in and marks it; what the posts do not show goes to the chat.
test('a link to a message finds its post: the thread opened, older pages read; or hands it on', async () => {
  const { DiscussionFeed, PLACE_PAGES } = loadTsx(CARD);
  assert.equal(PLACE_PAGES, 3);
  const all = new Map();
  const put = (m) => { all.set(m.id, m); return m; };
  [said(10, { replyCount: 5 }), said(20), said(30)].forEach(put);
  for (let id = 11; id <= 15; id += 1) put(said(id, { rootId: 10 }));
  [said(1), said(2), said(3), said(4, { rootId: 2 })].forEach(put);
  const pages = [];
  const source = {
    key: 'test', streamHoldsReplies: true,
    async page(before) {
      pages.push(before);
      // The newest page holds the posts since 20 and the last two replies of 10;
      // older pages hold 10 and its first replies, then the oldest posts.
      if (before == null) return { messages: [all.get(14), all.get(15), all.get(20), all.get(30)], more: true, readId: 0 };
      if (before === 14) return { messages: [10, 11, 12, 13].map((i) => all.get(i)), more: true, readId: null };
      return { messages: [1, 2, 3, 4].map((i) => all.get(i)), more: false, readId: null };
    },
    async thread(rootId) {
      return { root: all.get(rootId) || null, replies: [...all.values()].filter((m) => m.rootId === rootId).sort((a, b) => a.id - b.id) };
    },
    async post() { return null; }, async react() { return null; },
    async readPosition() { return 0; }, async markRead() {},
  };
  const feedOf = () => new DiscussionFeed(source, { since: null, fold_at: 8, earlier: null }, { current: 'me' });

  // A reply: its post, with the whole thread read and open.
  let room = feedOf();
  assert.deepEqual(await room.place({ threadRootId: 10, focusMessageId: 12 }), { key: 'post:10', messageId: 12 });
  assert.ok(room.get().opened.has(10), 'its replies box is open');
  assert.deepEqual(room.items().find((i) => i.key === 'post:10').replies.map((r) => r.id), [11, 12, 13, 14, 15]);

  // A post further back: older pages read until it is there; not opened.
  room = feedOf();
  assert.deepEqual(await room.place({ threadRootId: null, focusMessageId: 2 }), { key: 'post:2', messageId: 2 });
  assert.equal(room.get().opened.size, 0, 'a post alone opens nothing');

  // Gone, or past what the posts show: the chat takes it.
  room = feedOf();
  assert.equal(await room.place({ threadRootId: null, focusMessageId: 999 }), null);
  assert.equal(await feedOf().place({ threadRootId: null, focusMessageId: null }), null);

  // With the fold, an old message's own thread is the chat's.
  const folded = new DiscussionFeed(source, { since: SINCE, fold_at: 8, earlier: { count: 12, from: SINCE, to: SINCE, last_id: 3 } }, { current: 'me' });
  assert.equal(await folded.place({ threadRootId: 2, focusMessageId: 4 }), null, 'a reply to an old message is not on the posts');
  const old = await folded.place({ threadRootId: null, focusMessageId: 2 });
  assert.deepEqual(old, { key: 'earlier', messageId: 2 }, 'an old message is a reply of the Earlier post');
  assert.ok(folded.get().opened.has(3), 'which opens');

  // The page takes only the targets that are its own; the chat the rest.
  const card = read(CARD);
  assert.match(card, /const target = takeDiscussionTarget\(slug, null, 'posts'\);/);
  assert.match(card, /if \(found\) setFocus\(found\);\s*else missing\.current\?\.\(target\);/);
  assert.match(card, /_landOnDiscussion\?\.\(slug, \{ threadRootId, asChat: true,/, 'its own links into #general ask for the chat');
  assert.match(read('frontend/src/features/dev-board/workshop/project-discussion.tsx'),
    /if \(waiting && !topicRef && \(view\?\._discussionPlaceFor\?\.\(waiting\) \|\| 'discussion'\) !== place\) return null;/);
  assert.match(read('public/css/app.css'), /\.dh-msg\[data-ws-discussion-marked\] \{[^}]*animation: dh-marked 2\.4s ease-out;/);
});

// Part 2: the room live. A project's chat socket says what was said; Homeroom's
// #general (a Messages room) names what changed, and the card reads it again.
test('the room live: a socket frame is drawn as it lands, a changed room is read again', async () => {
  const me = 'priya';
  const chat = feed.liveFromAppFrame({ type: 'chat', id: 50, userId: 2, username: 'dev', content: 'hi', msgType: 'message', createdAt: SINCE }, me);
  assert.equal(chat.kind, 'said');
  assert.deepEqual([chat.said.id, chat.said.rootId, chat.said.who.username, chat.said.content], [50, null, 'dev', 'hi']);
  const reply = feed.liveFromAppFrame({ type: 'chat', id: 51, userId: 2, username: 'dev', content: 'yes', thread: { type: 'message', ref: 10 }, createdAt: SINCE }, me);
  assert.equal(reply.said.rootId, 10);
  assert.equal(feed.liveFromAppFrame({ type: 'chat', id: 52, userId: 2, username: 'dev', content: 'x', thread: { type: 'category', ref: 3 } }, me), null, 'a topic\'s message is not #general\'s');
  assert.equal(feed.liveFromAppFrame({ type: 'typing', username: 'dev' }, me), null);
  assert.deepEqual(feed.liveFromAppFrame({ type: 'thread_summary', root_id: 10, thread: { reply_count: 4, last_reply_at: SINCE } }, me),
    { kind: 'thread', rootId: 10, replyCount: 4, lastReplyAt: SINCE });
  assert.deepEqual(feed.liveFromAppFrame({ type: 'chat_edit', messageId: 10, content: 'edited' }, me), { kind: 'edit', id: 10, content: 'edited' });
  assert.deepEqual(feed.liveFromAppFrame({ type: 'reaction', messageId: 10, reactions: [{ emoji: '👍', count: 2, users: ['dev', 'priya'] }] }, me),
    { kind: 'reactions', id: 10, reactions: [{ emoji: '👍', count: 2, reacted: true, users: ['dev', 'priya'] }] });
  assert.deepEqual(feed.liveFromAppFrame({ type: 'chat_delete', id: 10 }, me), { kind: 'gone', id: 10 });
  assert.deepEqual(feed.liveFromAppFrame({ type: 'resync_hint' }, me), { kind: 'stale', messageId: null, rootId: null });
  assert.deepEqual(feed.liveFromConversationEvent({ type: 'conversation_message_created', conversationId: 7, messageId: 9, threadRootId: 4 }, 7),
    { kind: 'stale', messageId: 9, rootId: 4 });
  assert.equal(feed.liveFromConversationEvent({ conversationId: 8, messageId: 9 }, 7), null, 'another room\'s');

  // The feed draws each as it lands.
  const { DiscussionFeed } = loadTsx(CARD);
  let reads = 0;
  const source = {
    key: 'live', streamHoldsReplies: true,
    async page() { reads += 1; return { messages: [said(10, { replyCount: 1 }), said(11, { rootId: 10 })], more: false, readId: 0 }; },
    async thread() { return { root: null, replies: [] }; },
    async post() { return null; }, async react() { return null; },
    async readPosition() { return 0; }, async markRead() {},
    async ranked() { return { ids: [], more: false }; },
    live() { return () => {}; },
  };
  const room = new DiscussionFeed(source, null, { current: me });
  await room.load();
  room.heard(feed.liveFromAppFrame({ type: 'chat', id: 60, userId: 2, username: 'dev', content: 'new post', createdAt: SINCE }, me));
  room.heard(feed.liveFromAppFrame({ type: 'chat', id: 61, userId: 2, username: 'dev', content: 'a reply', thread: { type: 'message', ref: 10 }, createdAt: SINCE }, me));
  let post = room.items().find((i) => i.key === 'post:10');
  assert.deepEqual([post.replyCount, post.replies.map((r) => r.id)], [2, [11, 61]], 'a reply lands under its post, which counts it');
  assert.ok(room.items().some((i) => i.key === 'post:60'), 'a new post is drawn');
  room.heard(feed.liveFromAppFrame({ type: 'chat', id: 61, userId: 2, username: 'dev', content: 'a reply', thread: { type: 'message', ref: 10 }, createdAt: SINCE }, me));
  assert.equal(room.items().find((i) => i.key === 'post:10').replyCount, 2, 'the same message twice is counted once');
  room.heard({ kind: 'thread', rootId: 10, replyCount: 5, lastReplyAt: SINCE });
  room.heard({ kind: 'edit', id: 60, content: 'new post, edited' });
  room.heard({ kind: 'reactions', id: 60, reactions: [{ emoji: '🎉', count: 1, reacted: false, users: ['dev'] }] });
  room.heard({ kind: 'gone', id: 11 });
  post = room.items().find((i) => i.key === 'post:10');
  assert.equal(post.replyCount, 5);
  assert.deepEqual(post.replies.map((r) => r.id), [61], 'a reply taken back leaves its post');
  const fresh = room.items().find((i) => i.key === 'post:60');
  assert.deepEqual([fresh.root.content, fresh.root.reactions[0].emoji], ['new post, edited', '🎉']);
  // A room that only says something changed is read again, once for a burst.
  const before = reads;
  room.heard({ kind: 'stale', messageId: 9, rootId: null });
  room.heard({ kind: 'stale', messageId: 10, rootId: null });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(reads, before + 1);

  // Held while on screen: the source's live events and the page's own "read it again".
  const card = read(CARD);
  assert.match(card, /const stopSource = this\.source\.live\(\(event\) => this\.heard\(event\)\);\s*const stopReads = watchLiveReads\(\(\) => this\.refresh\(\)\);/);
  assert.match(read(FEED), /new WebSocket\(`\$\{proto\}\/\/\$\{location\.host\}\/ws\/chat\/\$\{encodeURIComponent\(slug\)\}\$\{qs\}`\)/);
  assert.match(read(FEED), /window\.addEventListener\('usernode:conversation-changed', changed\)/);
  assert.match(read('public/js/app.js'), /window\.UsernodeReact\?\.messages\?\.handleEvent\?\.\(data\);[\s\S]{0,500}window\.dispatchEvent\(new CustomEvent\('usernode:conversation-changed', \{ detail: data \}\)\)/);
});

test('Most replies is the whole room\'s: the server ranks, the card reads the busiest posts in', async () => {
  const { DiscussionFeed } = loadTsx(CARD);
  const asked = [];
  const threads = [];
  const source = {
    key: 'rank', streamHoldsReplies: true,
    async page() { return { messages: [said(40), said(41)], more: true, readId: 0 }; },
    async thread(rootId) {
      threads.push(rootId);
      return { root: said(rootId, { replyCount: 2 }), replies: [said(rootId + 100, { rootId }), said(rootId + 101, { rootId })] };
    },
    async post() { return null; }, async react() { return null; },
    async readPosition() { return 0; }, async markRead() {},
    async ranked(after, offset, limit) {
      asked.push([after, offset, limit]);
      return offset === 0 ? { ids: [7, 3, 40], more: true } : { ids: [2], more: false };
    },
    live() { return () => {}; },
  };
  const fold = { since: SINCE, fold_at: 8, earlier: null };
  const room = new DiscussionFeed(source, fold, { current: 'me' });
  await room.load();
  await room.rankTo(8);
  assert.deepEqual(asked[0], [0, 0, 8], 'from the start of the room, a page of eight');
  assert.deepEqual(threads.sort((a, b) => a - b), [2, 3, 7], 'each ranked post not here is read with its thread');
  const top = feed.sortItems(room.items(), 'replies').map((i) => i.key);
  assert.deepEqual(top.slice(0, 3), ['post:7', 'post:3', 'post:2']);
  assert.deepEqual(room.get().ranked, [7, 3, 40, 2]);
  assert.equal(room.get().rankedMore, false);
  // With the fold, the ranking starts after its last message.
  const folded = new DiscussionFeed(source, { since: SINCE, fold_at: 8, earlier: { count: 9, from: SINCE, to: SINCE, last_id: 30 } }, { current: 'me' });
  await folded.load();
  asked.length = 0;
  await folded.rankTo(1);
  assert.deepEqual(asked[0], [30, 0, 8]);
  // A ranking that cannot be read leaves the posts sorted as they are.
  const offline = new DiscussionFeed({ ...source, async ranked() { throw new Error('down'); } }, fold, { current: 'me' });
  await offline.load();
  await offline.rankTo(8);
  assert.equal(offline.get().rankedMore, false);
  const view = read(CARD);
  assert.match(view, /if \(sort !== 'replies' \|\| mode === 'preview' \|\| state\.status !== 'ready'\) return;\s*void feed\.rankTo\(limit\);/);
  // The route: who gets the channel may rank it.
  const route = read('src/routes/apps.js');
  assert.match(route, /router\.get\('\/api\/apps\/:slug\/discussion\/most-replied'/);
  assert.match(route, /return res\.json\(await discussion\.rankedInConversation\(pool, conversationId, opts\)\);/);
  assert.match(route, /if \(!\(await appAccess\.checkAppAccess\(pool, app, req\.user, 'collab'\)\)\) \{\s*return res\.status\(404\)/);
  const server = require('../src/services/discussion');
  const sql = [];
  const pool = { query: async (text, args) => { sql.push([text, args]); return { rows: [{ id: '5', reply_count: 3, active_at: new Date(SINCE) }, { id: '4', reply_count: 0, active_at: SINCE }] }; } };
  assert.deepEqual(await server.rankedInApp(pool, 9, { viewerId: 1, afterId: 'x', limit: 1, offset: -4 }),
    { posts: [{ id: 5, reply_count: 3, active_at: SINCE }], more: true });
  assert.deepEqual(sql[0][1], [9, 0, 1, 2, 0], 'bad bounds are read as none');
  assert.match(sql[0][0], /ORDER BY reply_count DESC, active_at DESC, m\.id DESC/);
  await server.rankedInConversation(pool, 3, { limit: 500 });
  assert.equal(sql[1][1][3], server.RANKED_MAX + 1, 'a page is at most RANKED_MAX');
});

test('the server says what was said before Discussion, best-effort, beside the channel', async () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /discussion: await discussion\.discussionSummary\(pool, \{ conversationId, viewerId: req\.user\?\.id \}\),/);
  assert.match(route, /discussion: await discussion\.discussionSummary\(pool, \{ appId: app\.id, viewerId: req\.user\?\.id \}\),/);
  assert.match(read('src/db/reference-data.js'), /\('discussion_posts_since', to_char\(NOW\(\) AT TIME ZONE 'UTC'/);
  const server = require('../src/services/discussion');
  server.resetDiscussionSinceForTest();
  const failing = { query: async () => { throw new Error('down'); } };
  assert.deepEqual(await server.discussionSummary(failing, { appId: 1 }), { since: null, fold_at: 8, earlier: null });
  server.resetDiscussionSinceForTest();
  const rows = (sql) => (sql.includes('platform_settings')
    ? { rows: [{ value: SINCE }] }
    : { rows: [{ n: 12, first_at: '2026-10-02T00:00:00Z', last_at: '2026-11-24T00:00:00Z', last_id: 40 }] });
  const seen = [];
  const pool = { query: async (sql, params) => { seen.push([sql, params]); return rows(sql); } };
  assert.deepEqual(await server.discussionSummary(pool, { appId: 3, viewerId: 7 }), {
    since: SINCE, fold_at: 8,
    earlier: { count: 12, from: '2026-10-02T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z', last_id: 40 },
  });
  assert.match(seen[1][0], /FROM chat_messages m[\s\S]*m\.thread_type IS NULL[\s\S]*m\.created_at < \$2::timestamptz/);
  assert.deepEqual(seen[1][1], [3, SINCE, 7]);
  await server.discussionSummary(pool, { conversationId: 5, viewerId: 7 });
  assert.match(seen[seen.length - 1][0], /FROM conversation_messages m[\s\S]*m\.thread_root_id IS NULL/);
  server.resetDiscussionSinceForTest();
});

test('a reaction on an app channel has a REST door, through the socket\'s own handler', () => {
  const chat = read('src/routes/chat.js');
  const at = chat.indexOf("router.post('/api/apps/:slug/messages/:id/reactions'");
  assert.ok(at > 0);
  const route = chat.slice(at, chat.indexOf('// ── #2387: the read cursor', at));
  assert.match(route, /groupChatWriteLimiter, sameOriginBrowserOnly/);
  assert.match(route, /appAccess\.getAppForUser\(\s*pool, req\.params\.slug, req\.user, 'collab'/);
  assert.match(route, /ws\.handleMessage\(\s*pool,\s*\{ user: req\.user, appId: app\.id, appSlug: app\.slug \},\s*\{ type: 'react', messageId, emoji \}\s*\)/);
});

test('the staging copies have a project to show it on, with fake people only', () => {
  const migrate = read('src/db/migrate.js');
  const seed = migrate.slice(migrate.indexOf('async function seedStagingDiscussion'), migrate.indexOf("// #7170's shots"));
  assert.match(seed, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.match(seed, /'staging-demo-discussion', 'Staging demo: Book Club'/);
  assert.match(seed, /'staging-demo-discussion-busy', 'Staging demo: Trail Runners'/);
  assert.match(seed, /`Staging demo: \$\{content\}`/, 'every message says it is fake');
  assert.match(migrate, /stagingSeed\('seedStagingDiscussion'/);
});

test('every word is the catalog\'s', () => {
  assert.equal(message('project:hub.discussion.title'), 'Discussion');
  assert.equal(message('project:hub.discussion.start.placeholder'), 'Start a post…');
  assert.equal(message('project:hub.discussion.reply.placeholder'), 'Reply in thread…');
  assert.equal(message('project:hub.discussion.sort.replies'), 'Most replies');
  assert.equal(message('project:hub.discussion.earlier.title'), 'Earlier in #general');
  assert.equal(message('project:page.title.discussion'), 'Discussion');
});
