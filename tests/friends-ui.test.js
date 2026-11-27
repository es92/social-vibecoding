// Mutual friends (#2386) on screen: the button on a person's page, the
// private Friends section on your own, the friend rows in the bell, and the
// Messages composer's @ list putting friends first.
//
// Rendered through tests/lib/render-tsx.js wherever the decision lives in a
// render, and read from the shipped source where it lives in a wire-up.
//
// Run with: node --test tests/friends-ui.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const NOW = Date.parse('2026-09-23T12:00:00Z');

test('the button says one thing per state, and only Requested / Friends open a menu', () => {
  const { friendsButtonView } = loadTsx('frontend/src/features/friends/friend-button.tsx');
  const v = (state) => friendsButtonView(state, 'lin');
  assert.deepEqual(v('none').primary, { action: 'request', label: 'Add friend', accent: true });
  assert.deepEqual(v('outgoing').primary, { action: 'menu', label: 'Requested', accent: false });
  assert.equal(v('outgoing').menu.label, 'Cancel request');
  assert.equal(v('outgoing').menu.action, 'cancel');
  assert.deepEqual(v('incoming').primary, { action: 'accept', label: 'Accept', accent: true });
  assert.deepEqual(v('incoming').secondary, { action: 'decline', label: 'Decline' });
  assert.deepEqual(v('friends').primary, { action: 'menu', label: 'Friends', accent: false });
  assert.equal(v('friends').menu.label, 'Unfriend');
  assert.match(v('friends').menu.confirm, /won’t be told/, 'unfriending is silent, and says so');
  assert.equal(v('garbage').primary.label, 'Add friend');
});

test('each state renders its controls, marked for the declared checks', () => {
  const { FriendButton } = loadTsx('frontend/src/features/friends/friend-button.tsx');
  const html = (state) => renderToHtml(createElement(FriendButton, { userId: 910002, username: 'lin', initialState: state }));
  const none = html('none');
  assert.match(none, /data-friend-button="lin"/);
  assert.match(none, /data-friend-state="none"/);
  assert.match(none, /data-friend-action="request"[^>]*>.*Add friend/);
  const outgoing = html('outgoing');
  assert.match(outgoing, /data-friend-action="menu"[^>]*aria-haspopup="menu"/);
  assert.match(outgoing, />Requested</);
  const incoming = html('incoming');
  assert.match(incoming, /data-friend-action="accept"/);
  assert.match(incoming, /data-friend-action="decline"/);
  const friendsHtml = html('friends');
  assert.match(friendsHtml, />Friends</);
  assert.match(friendsHtml, /<svg/, 'the ✓');
  for (const out of [none, outgoing, incoming, friendsHtml]) {
    assert.doesNotMatch(out, /\d+ friends?/i, 'no counts, anywhere');
    assert.doesNotMatch(out, /bg-violet-600[^"]*"[^>]*>[^<]*Requested/, 'Requested is not a primary action');
  }
});

test('the client names every route literally, and refusals never say why', () => {
  const api = loadTsx('frontend/src/features/friends/api.ts');
  assert.deepEqual(['request', 'cancel', 'accept', 'decline', 'unfriend'].map((a) => api.actionRoute(12, a)), [
    { method: 'POST', path: '/api/friends/12/request' },
    { method: 'DELETE', path: '/api/friends/12/request' },
    { method: 'POST', path: '/api/friends/12/accept' },
    { method: 'POST', path: '/api/friends/12/decline' },
    { method: 'DELETE', path: '/api/friends/12' },
  ]);
  assert.equal(api.errorMessage({ status: 404 }, 'lin'), 'You can’t add @lin as a friend right now.');
  const capped = new api.FriendsApiError(429, 'You can send up to 50 friend requests a day. Try again tomorrow.');
  assert.match(api.errorMessage(capped, 'lin'), /50 friend requests a day/, 'a cap says what it is');
  assert.equal(api.normalizeState('friends'), 'friends');
  assert.equal(api.normalizeState('blocked'), 'none', 'there is no fifth state to leak');
  assert.deepEqual(api.normalizeLists({ friends: [{ id: 3, username: 'ada', avatarUrl: 'javascript:1' }] }), {
    friends: [{ id: 3, username: 'ada', avatarUrl: null, since: null, requestedAt: null }],
    incoming: [],
    outgoing: [],
  });
});

test('friends lead a picker the page already has, each group in its own order', () => {
  const { orderFriendsFirst } = loadTsx('frontend/src/features/friends/store.ts');
  const members = [{ id: 1, username: 'amy' }, { id: 2, username: 'bo' }, { id: 3, username: 'cy' }, { id: 4, username: 'di' }];
  assert.deepEqual(orderFriendsFirst(members, new Set([4, 2])).map((m) => m.username), ['bo', 'di', 'amy', 'cy']);
  assert.deepEqual(orderFriendsFirst(members, new Set()).map((m) => m.id), [1, 2, 3, 4]);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /import \{ orderFriendsFirst, useFriendIds \} from '\.\.\/friends\/store';/);
  // One message box (27 Nov 2026): the roster is the place's.
  assert.match(composer, /orderFriendsFirst\(\(roster \|\| \[\]\)\.filter\([\s\S]*?\), friendIds\)\.slice\(0, 6\)/,
    'the order is applied BEFORE the six-row cap, so a friend is never cut off by a stranger');
  const store = read('frontend/src/features/friends/store.ts');
  assert.match(store, /useEffect\(\(\) => \{ void loadFriendIds\(\); \}/, 'loaded from an effect, never a render');
});

test('the own Friends section: requests first, then friends, then what you sent, and never a count', () => {
  const { friendsView } = loadTsx(STORE);
  const view = friendsView({
    friends: [{ id: 1, username: 'ada', avatarUrl: '/avatars/' + 'a'.repeat(32), since: '2026-03-04T10:00:00Z' }],
    incoming: [{ id: 2, username: 'lin', avatarUrl: 'https://evil.example/x.png', requestedAt: '2026-09-20T12:00:00Z' }],
    outgoing: [{ id: 3, username: 'grace', requestedAt: '2026-09-22T12:00:00Z' }],
  }, NOW);
  assert.equal(view.loaded, true);
  assert.deepEqual(view.incoming.map((r) => [r.username, r.href, r.meta, r.avatarUrl]),
    [['lin', '#profile/lin', 'Asked 3d ago', null]]);
  assert.equal(view.friends[0].href, '#profile/ada');
  assert.match(view.friends[0].meta, /^Friends since \S+ 2026$/);
  assert.equal(view.friends[0].avatarUrl, '/avatars/' + 'a'.repeat(32));
  assert.deepEqual(view.outgoing.map((r) => [r.username, r.meta]), [['grace', 'Requested 1d ago']],
    'the pending cap says to cancel one, so they are all listed here');
  assert.deepEqual(friendsView(null), { loaded: false, incoming: [], friends: [], outgoing: [] },
    'a failed read is told apart from "no friends yet"');
});

test('a person\'s page gets the button only for a signed-in viewer looking at someone else', () => {
  const { buildProfileView } = loadTsx(STORE);
  const page = (user, friendship) => buildProfileView({
    open: true,
    user,
    data: { publicProfile: { username: 'lin' }, publicFriendship: friendship },
  });
  const f = { userId: 910002, state: 'incoming' };
  assert.deepEqual(page({ username: 'evan', hasPlatformAccess: true }, f).friendship, f);
  assert.equal(page({ username: 'Lin' }, f).friendship, null, 'never on your own page');
  assert.equal(page({}, f).friendship, null, 'never for a signed-out visitor');
  assert.equal(page({ username: 'evan', hasPlatformAccess: false }, f).friendship, null);
  assert.equal(page({ username: 'evan' }, null).friendship, null, 'nothing drawn without the payload');
  assert.equal(page({ username: 'evan' }, { userId: 3, state: 'blocked' }).friendship, null);
});

test('the public card puts the button on its own row under the name', () => {
  const card = loadTsx('frontend/src/features/profile/public-profile-card.tsx', {
    stubs: { './profile.js': { Profile: { sendReport: async () => ({ ok: true, status: '' }) } } },
  });
  const profile = { username: 'lin', displayName: 'Lin', bio: 'Hi', links: {} };
  const withButton = renderToHtml(createElement(card.PublicProfileCard, {
    profile, allowReport: true, allowMessage: true, friendship: { userId: 910002, state: 'friends' },
  }));
  assert.match(withButton, /id="public-profile-friend"[^>]*>.*data-friend-button="lin"[^>]*data-friend-state="friends"/);
  assert.ok(withButton.indexOf('data-message-person="lin"') < withButton.indexOf('id="public-profile-friend"'),
    'Message keeps its place at the end of the name row');
  const without = renderToHtml(createElement(card.PublicProfileCard, { profile, allowReport: false }));
  assert.doesNotMatch(without, /data-friend-button/, 'the owner\'s preview and anonymous reads draw none');
});

test('Me\'s Friends row opens the private Friends section as a card', () => {
  const real = loadTsx(STORE);
  const state = {
    open: true,
    data: {
      ranking: {}, summary: { merged: 0, kudos: 0, contributions: [] }, ownerPublicProfile: null,
      friends: { friends: [{ id: 1, username: 'ada' }], incoming: [{ id: 2, username: 'lin' }], outgoing: [{ id: 3, username: 'grace' }] },
    },
    user: { username: 'evan', links: {} },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
    friendsPending: 2, friendsStatus: '', friendsOpen: true,
  };
  const mod = loadTsx('frontend/src/features/profile/profile-view.tsx', {
    stubs: { './profile-store.js': { ...real, profileStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const html = renderToHtml(createElement(mod.ProfileRoot, {}));
  const at = (needle) => html.indexOf(needle);
  // A row of Account (UI overhaul; it led the "More" list before the
  // navigation review regrouped it), saying only how many requests wait; its
  // card, when open, holds the section it used to be.
  assert.match(html, /id="profile-row-friends"[\s\S]*?1 request waiting/);
  assert.ok(at('id="profile-friends-sheet"') >= 0 && at('id="profile-friends-sheet"') < at('id="profile-friends"'),
    'the section is in the card');
  assert.match(html, /<h2 class="text-lg font-bold">Friends<\/h2>/, 'titled by the card, not a second label');
  assert.ok(at('id="profile-friend-requests"') < at('id="profile-friends-list"'), 'requests lead');
  assert.match(html, /data-friend-request="lin"/);
  assert.match(html, /data-friend-request-accept="lin"[^>]*disabled/, 'the row being answered is inert');
  assert.match(html, /<a[^>]*href="#profile\/ada"[^>]*data-friend="ada"|<a[^>]*data-friend="ada"[^>]*href="#profile\/ada"/);
  assert.ok(at('id="profile-friends-list"') < at('id="profile-friend-sent"'), 'what you sent comes last');
  assert.match(html, /data-friend-sent="grace"[\s\S]*?data-friend-sent-cancel="grace"[^>]*>Cancel</);
  assert.match(read('frontend/src/features/profile/profile.js'), /await actOnFriend\(id, 'cancel'\)/);
  assert.match(html, /Only you can see your friends/);
  assert.doesNotMatch(html, /\b\d+ friends?\b/i, 'no count');
  const closedHtml = renderToHtml(createElement(loadTsx('frontend/src/features/profile/profile-view.tsx', {
    stubs: { './profile-store.js': { ...real, profileStore: { get: () => ({ ...state, friendsOpen: false }), subscribe: () => () => {} } } },
  }).ProfileRoot, {}));
  assert.doesNotMatch(closedHtml, /id="profile-friends"/, 'closed, it is a row and nothing more');

  const empty = renderToHtml(createElement(loadTsx('frontend/src/features/profile/profile-view.tsx', {
    stubs: { './profile-store.js': { ...real, profileStore: { get: () => ({ ...state, data: { ...state.data, friends: { friends: [], incoming: [], outgoing: [] } } }), subscribe: () => () => {} } } },
  }).ProfileRoot, {}));
  assert.match(empty, /id="profile-friends-empty"[^>]*>No friends yet/);
});

test('the controller reads the lists with Me, and the relationship with a person\'s page', () => {
  const profileJs = read('frontend/src/features/profile/profile.js');
  const load = profileJs.slice(profileJs.indexOf('async _load('), profileJs.indexOf('// ── rendering'));
  assert.match(load, /listFriends\(\)\.catch\(\(\) => null\)/, 'non-fatal, like the summary');
  assert.match(load, /publicFriendship: payload\.friendship \|\| null/);
  assert.match(load, /\/api\/public\/profiles\/\$\{encodeURIComponent\(target\)\}\$\{Profile\._demoQuery\(\)\}/);
  assert.match(profileJs, /window\.addEventListener\(FRIENDS_CHANGED_EVENT/,
    'a change anywhere on the page refreshes the own Friends section');
});

// notifications.js publishes its controller on `window`; bundled for its one
// import, the same way tests/notification-row-lines.test.js loads it.
function rowView() {
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  return globalThis.window.Notifications._rowView;
}

test('a friend request row asks with Accept / Decline until it is answered', () => {
  const view = rowView();
  const at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const base = { id: 5, createdAt: at, readAt: null, sourceUsername: 'lin', sourceUserId: 910002, appName: null };
  const pending = view({ ...base, kind: 'friend_request', friendRequestPending: true });
  assert.equal(pending.label, 'Friend request');
  assert.deepEqual(pending.segments, [{ t: 'who', v: 'lin' }]);
  assert.equal(pending.appLine, 'Friends');
  assert.equal(pending.by, null, 'the person is the subject, not an attribution');
  assert.deepEqual(pending.actions, [
    { key: 'friend_accept', label: 'Accept', primary: true },
    { key: 'friend_decline', label: 'Decline' },
  ]);
  const answered = view({ ...base, kind: 'friend_request', friendRequestPending: false });
  assert.equal('actions' in answered, false, 'answered, withdrawn or blocked: a plain row');
  const accepted = view({ ...base, kind: 'friend_accept' });
  assert.equal(accepted.label, 'Accepted your friend request');
  assert.equal('actions' in accepted, false);

  const source = read('frontend/src/features/notifications/notifications.js');
  assert.match(source, /window\.location\.hash = `#profile\/\$\{encodeURIComponent\(item\.sourceUsername\)\}`/,
    'a friend row opens the person\'s page');
  assert.match(source, /fetch\(`\/api\/friends\/\$\{userId\}\/accept`, init\)/);
  assert.match(source, /fetch\(`\/api\/friends\/\$\{userId\}\/decline`, init\)/);
  assert.match(source, /new CustomEvent\('usernode:friends-changed'\)/);
  const sheet = read('frontend/src/features/notifications/notifications-sheet.tsx');
  assert.match(sheet, /if \(actions\.length > 1\) return <div className="flex items-center gap-2 ps-\[3\.75rem\]">\{buttons\}<\/div>;/,
    'two actions go on their own line under the text, past the tile');
  assert.match(sheet, /<RowActions view=\{view\} actions=\{actions\} \/>/);
  assert.equal(
    loadTsx('frontend/src/features/friends/api.ts').FRIENDS_CHANGED_EVENT,
    'usernode:friends-changed',
    'the controller and the client raise the same event',
  );
});

// #3048: find friends by username from your own Friends section.
const SEARCH = 'frontend/src/features/friends/friend-search.tsx';

test('a search result starts in the state the section\'s own lists already say', () => {
  const { friendStateFor } = loadTsx(SEARCH);
  const lists = { friends: [{ id: 1 }], incoming: [{ id: 2 }], outgoing: [{ id: 3 }] };
  assert.equal(friendStateFor(1, lists), 'friends');
  assert.equal(friendStateFor(2, lists), 'incoming');
  assert.equal(friendStateFor(3, lists), 'outgoing');
  assert.equal(friendStateFor(4, lists), 'none');
  assert.equal(friendStateFor(3, { friends: [], incoming: [] }), 'none', 'outgoing is optional');
});

test('each result draws the same friend button a person\'s page does, and links to their page', () => {
  const { FriendSearchResults } = loadTsx(SEARCH);
  const lists = { friends: [{ id: 1, username: 'ada' }], incoming: [], outgoing: [{ id: 3, username: 'grace' }] };
  const html = renderToHtml(createElement(FriendSearchResults, {
    query: 'a', loading: false, failed: false, lists,
    users: [{ id: 1, username: 'ada', avatarUrl: null }, { id: 5, username: 'alan', avatarUrl: null }, { id: 3, username: 'grace', avatarUrl: null }],
  }));
  assert.match(html, /data-friend-search-result="ada"[\s\S]*?href="#profile\/ada"[\s\S]*?data-friend-state="friends"/);
  assert.match(html, /data-friend-search-result="alan"[\s\S]*?data-friend-state="none"[\s\S]*?data-friend-action="request"[^>]*>.*Add friend/);
  assert.match(html, /data-friend-search-result="grace"[\s\S]*?data-friend-state="outgoing"/);
  assert.doesNotMatch(html, /@[^<"]*\.[a-z]{2,}/i, 'no email is ever drawn');
  assert.doesNotMatch(html, /\b\d+ friends?\b/i, 'no count');
});

test('the search says when nothing matches, when it is still looking, and when it failed', () => {
  const { FriendSearchResults } = loadTsx(SEARCH);
  const base = { users: [], lists: { friends: [], incoming: [] } };
  const html = (props) => renderToHtml(createElement(FriendSearchResults, { ...base, ...props }));
  assert.equal(html({ query: '  ', loading: false, failed: false }), '', 'an empty box draws nothing');
  assert.match(html({ query: 'zz', loading: false, failed: false }), /No one matches “zz”/);
  assert.match(html({ query: 'zz', loading: true, failed: false }), /Searching…/);
  assert.match(html({ query: 'zz', loading: false, failed: true }), /Search isn’t working right now/);
});

test('Me\'s Friends section leads with the search box, which fetches nothing until you type', () => {
  const real = loadTsx(STORE);
  const state = {
    open: true,
    data: { ranking: {}, summary: { merged: 0, kudos: 0, contributions: [] }, ownerPublicProfile: null,
      friends: { friends: [], incoming: [], outgoing: [] } },
    user: { username: 'evan', links: {} },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false, friendsPending: null, friendsStatus: '',
    friendsOpen: true,
  };
  // The bell's test above leaves `window` as a bare globalThis; load the
  // profile controller the way the first Me test does, with no window at all.
  const savedWindow = globalThis.window;
  delete globalThis.window;
  let html;
  try {
    html = renderToHtml(createElement(loadTsx('frontend/src/features/profile/profile-view.tsx', {
      stubs: { './profile-store.js': { ...real, profileStore: { get: () => state, subscribe: () => () => {} } } },
    }).ProfileRoot, {}));
  } finally {
    if (savedWindow !== undefined) globalThis.window = savedWindow;
  }
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('id="profile-friends"') < at('id="profile-friend-search"'), 'inside the Friends section');
  assert.ok(at('id="profile-friend-search"') < at('id="profile-friends-empty"'), 'above the list');
  assert.match(html, /id="profile-friend-search-input"[^>]*placeholder="Find friends by username"/);
  assert.doesNotMatch(html, /profile-friend-search-results/, 'no results before anything is typed');
  assert.match(html, /No friends yet\. Find someone by username above\./);

  assert.match(read('frontend/src/features/profile/friends-section.tsx'), /\{heading \? <SectionHeader>\{t\('profile:friends\.title'\)\}<\/SectionHeader> : null\}\s*\{\/\*[^*]*\*\/\}\s*<FriendSearch lists=\{view\} \/>/,
    'the search sits right under the Friends header (the card\'s title, in the card)');
  const src = read(SEARCH);
  assert.match(src, /import \{ searchUsers \} from '\.\.\/messages\/api'/,
    'reuses the messages-scoped people search, which leaves out you and anyone blocked either way');
  assert.match(read('frontend/src/features/messages/api.ts'), /\/api\/users\/search\?q=\$\{[^}]+\}&scope=messages/);
  assert.match(src, /useEffect\(\(\) => \{[\s\S]*?window\.setTimeout/, 'searches from an effect, debounced');
});
