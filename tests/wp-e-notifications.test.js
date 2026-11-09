'use strict';

// WP-E: the words of the new notifications, on a phone and in the bell.
//
//   - "Your builds": the Homeroom bot's four moments as their own kinds, so
//     turning Messages off does not silence "it's ready to try". Worded by
//     the moment the detail names, as its messages always were.
//   - "Your invites": an open (a count, never a name), a join and a first
//     hello, for the link's maker; a day's moments fold into one row.
//   - The invite page tells a visitor that the maker sees when they join, and
//     the made screen says about how long a build usually takes.
//
// Run with: node --test tests/wp-e-notifications.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const policy = require('../src/services/mobile-push-policy');
const dm = require('../src/services/homeroom-bot-dm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('each ringing moment of the bot has its own kind; an answer stays a message', () => {
  // "One story": the moments by their names, and the older names a sender may still use.
  assert.deepEqual({ ...dm.BUILD_KINDS }, {
    needs_you: 'build_needs_you', ready: 'build_ready', stopped: 'build_stopped', on_hold: 'build_stopped', live: 'build_live',
    question: 'build_needs_you', held: 'build_stopped',
    // 16 Oct 2026: somebody else's change shipped it; it rings as the news it is.
    done_elsewhere: 'build_live',
  });
  assert.equal(dm.BUILD_KINDS.reply, undefined);
  const src = read('src/services/homeroom-bot-dm.js');
  // One story: the moment the message is (contract 2.1) names its kind.
  assert.match(src, /notificationKind: \(story && BUILD_KINDS\[story\]\) \|\| null,/);
  // Only a direct conversation takes the kind; a group or channel keeps its own.
  assert.match(read('src/services/conversations.js'),
    /if \(membership\.kind === 'direct' && notificationKind\) kind = notificationKind;/);
});

test('a build moment\'s push is worded by its moment, with a fallback per kind', () => {
  const copy = (kind, detail) => policy.buildNotificationCopy(kind, { detail, sourceUsername: 'homeroom_bot' });
  // "One story": rows written before it keep reading, as the moments they are.
  assert.deepEqual(copy('build_ready', 'hrbot:ready:Run Club'), { title: 'Run Club', body: 'Ready to try. Try it, and approve it if you\'re happy.' });
  assert.deepEqual(copy('build_needs_you', 'hrbot:question:Run Club'), { title: 'Run Club', body: 'I have a question before I build it.' });
  assert.deepEqual(copy('build_live', 'hrbot:live_first:Run Club'), { title: 'Run Club', body: 'Your first version is live. Open Run Club to try it.' });
  assert.deepEqual(copy('build_stopped', null), { title: 'Homeroom bot', body: 'Stopped. I said why in our chat.' });
});

test('invite news on a phone: an open is nobody, a join and a hello are the person', () => {
  const copy = (kind, extra) => policy.buildNotificationCopy(kind, { appName: 'Run Club', ...extra });
  assert.deepEqual(copy('invite_opened', { sourceUsername: null }),
    { title: 'Someone opened your invite to Run Club', body: 'You hear when they join' });
  assert.deepEqual(copy('member_joined', { sourceUsername: 'sam' }),
    { title: '@sam joined Run Club', body: 'They came in through your invite. Say hello' });
  assert.deepEqual(copy('first_message', { sourceUsername: 'sam', messageContent: 'hi **all**' }),
    { title: '@sam said hi in Run Club', body: 'hi all' });
});

let rowView = null;
function bellRow(n) {
  if (!rowView) {
    if (!globalThis.window) globalThis.window = globalThis;
    globalThis.PlatformI18n = englishPlatformI18n();
    loadTsx('frontend/src/features/notifications/notifications.js');
    rowView = globalThis.window.Notifications._rowView;
  }
  const view = rowView({
    id: 1, createdAt: new Date().toISOString(), readAt: null, appName: 'Run Club', appSlug: 'run-club', ...n,
  });
  return {
    label: view.label,
    subject: view.segments.map((s) => s.v).join(' '),
    by: view.by,
  };
}

test('invite news in the bell, folded into a count', () => {
  assert.deepEqual(bellRow({ kind: 'invite_opened', detail: null, sourceUsername: null }),
    { label: 'Someone opened your invite', subject: '', by: null });
  assert.deepEqual(bellRow({ kind: 'invite_opened', detail: '3' }),
    { label: '3 people opened your invite', subject: '', by: null });
  assert.deepEqual(bellRow({ kind: 'member_joined', detail: null, sourceUsername: 'sam' }),
    { label: 'Joined through your invite', subject: '', by: 'sam' });
  assert.deepEqual(bellRow({ kind: 'member_joined', detail: '2', sourceUsername: 'alex' }),
    { label: 'Joined through your invite, with 1 other', subject: '', by: 'alex' });
  assert.deepEqual(bellRow({ kind: 'first_message', detail: '3', sourceUsername: 'sam', messageContent: 'hello!' }),
    { label: 'Said hi, with 2 others', subject: 'hello!', by: 'sam' });
});

test('the leaked-link guard on a phone and in the bell: the count, and a button only while it does something', () => {
  // A phone: `detail` is "<inviteId>:<joins>" (invite-activity.js noteGuard).
  const copy = (kind, extra) => policy.buildNotificationCopy(kind, { appName: 'Run Club', ...extra });
  assert.deepEqual(copy('invite_link_busy', { detail: '41:20' }),
    { title: 'Your Run Club invite link brought in 20 people today', body: 'If you didn\'t expect that, you can turn it off' });
  assert.deepEqual(copy('invite_link_paused', { detail: '41:100' }),
    { title: 'Your Run Club invite link is paused', body: '100 people joined through it today. Open it again if that\'s expected.' });
  assert.deepEqual(copy('invite_link_paused', { detail: '41:100', appName: null }),
    { title: 'Your invite link is paused', body: '100 people joined through it today. Open it again if that\'s expected.' });

  // The bell: the whole sentence is the label, and the buttons follow the
  // link's state as the server read it with the row.
  const actions = (n) => {
    if (!rowView) bellRow({ kind: 'invite_opened' });
    return (rowView({ id: 2, createdAt: new Date().toISOString(), readAt: null, appName: 'Run Club', appSlug: 'run-club', ...n }).actions || [])
      .map((a) => a.key);
  };
  assert.deepEqual(bellRow({ kind: 'invite_link_busy', detail: '41:20', inviteLinkState: 'live' }),
    { label: 'Your Run Club invite link brought in 20 people today.', subject: '', by: null });
  assert.deepEqual(bellRow({ kind: 'invite_link_paused', detail: '41:100', inviteLinkState: 'paused' }), {
    label: 'Your Run Club invite link is paused: 100 people joined through it today. Open it again if that\'s expected.',
    subject: '', by: null,
  });
  assert.deepEqual(actions({ kind: 'invite_link_busy', detail: '41:20', inviteLinkState: 'live' }), ['invite_turn_off']);
  assert.deepEqual(actions({ kind: 'invite_link_busy', detail: '41:20', inviteLinkState: 'ended' }), [], 'already off');
  assert.deepEqual(actions({ kind: 'invite_link_paused', detail: '41:100', inviteLinkState: 'paused' }), ['invite_reopen', 'invite_turn_off']);
  assert.deepEqual(actions({ kind: 'invite_link_paused', detail: '41:100', inviteLinkState: 'live' }), ['invite_turn_off'], 'opened again');
  assert.deepEqual(actions({ kind: 'invite_link_paused', detail: '0:100', inviteLinkState: null }), [], 'a test row turns nothing off');
  // The buttons are the pane's own calls.
  const src = read('frontend/src/features/notifications/notifications.js');
  assert.match(src, /reopen \? `\/api\/invite-links\/\$\{guard\.inviteId\}\/reopen` : `\/api\/invite-links\/\$\{guard\.inviteId\}`/);
  // The server reads the link's state with the row, only the reader's own link.
  const server = read('src/services/notifications.js');
  assert.match(server, /WHERE guarded\.id = split_part\(n\.detail, ':', 1\)::int AND guarded\.created_by = n\.user_id\) END`;/);
  assert.match(server, /\$\{INVITE_LINK_STATE_SQL\} AS invite_link_state`;/);
});

test('a build moment in the bell is the bot\'s, in its own words', () => {
  const row = bellRow({
    kind: 'build_ready', detail: 'hrbot:ready:Run Club', appName: null, appSlug: null,
    conversationId: 7, conversationKind: 'direct', sourceUsername: 'homeroom_bot',
  });
  // "One story": the moment over the request (an old row has only its project).
  assert.deepEqual(row, { label: 'Ready to try', subject: 'Run Club', by: null });
});

test('no invite surface says the maker sees a join; the made screen promises no time', () => {
  const card = loadTsx('frontend/src/features/auth/invite-card.tsx');
  assert.equal(card.seenLine, undefined, 'the signed-out invite page names nobody who will see the join (owner, 8 October)');
  assert.doesNotMatch(read('frontend/src/features/auth/invite-card.tsx'), /will see that you joined/);
  assert.doesNotMatch(read('public/js/app.js'), /will see that you joined/, 'nor does the signed-in confirm (#4395)');
  // WP-E said "usually in about 8 minutes" here, an ordinary request's
  // typical build; a first version took 50 (first-session run-through, 5
  // October 2026), and Evan asked for no average at all.
  const { buildNote } = loadTsx('frontend/src/features/first-session/made.tsx');
  assert.equal(buildNote(true), 'Homeroom is making your app. It will message you when the first version is ready to try, or if it has any questions.');
  assert.equal(buildNote(false), 'You or anyone you invite can build it from there.');
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /useEffect\(\(\) => \{ if \(botBuilds\) askForPingWhileBotBuilds\(\); \}, \[botBuilds\]\);/);
  assert.doesNotMatch(read('src/routes/apps.js'), /typicalMinutes: await botDm\.typicalMinutesCached\(pool\)/);
});

test('the browser an open came from: a random HttpOnly cookie, kept only as its hash', () => {
  const activity = require('../src/services/invite-activity');
  const set = [];
  const res = { cookie(name, value, opts) { set.push({ name, value, opts }); } };
  const key = activity.ensureBrowser({ cookies: {}, headers: { 'x-forwarded-proto': 'https' } }, res);
  assert.equal(set.length, 1);
  assert.equal(set[0].name, 'hr_iv');
  assert.match(set[0].value, /^[A-Za-z0-9_-]{32}$/, 'random, and nothing about the browser or where it is');
  const { maxAge, ...rest } = set[0].opts;
  assert.deepEqual(rest, { httpOnly: true, sameSite: 'lax', secure: true, path: '/api' });
  assert.ok(maxAge >= 30 * 24 * 60 * 60 * 1000, 'kept for as long as a link is likely to be opened again');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes(set[0].value), 'the database keeps a hash, never the cookie');
  // The same browser next time: the same person, and no new cookie.
  assert.equal(activity.ensureBrowser({ cookies: { hr_iv: set[0].value }, headers: {} }, res), key);
  assert.equal(set.length, 1);
  assert.equal(activity.browserFrom({ cookies: { hr_iv: 'x' } }), null, 'not one of ours');
  assert.equal(activity.browserFrom({}), null);
  // A browser counted for a link before opens were kept by person.
  assert.equal(activity.countedBefore({ cookies: { hr_io_abcdefghijkl: '1' } }, 'abcdefghijklmnopqrstuv'), true);
  assert.equal(activity.countedBefore({ cookies: {} }, 'abcdefghijklmnopqrstuv'), false);
});

test('opens are counted from the page\'s own reads, once per person, never from the unfurled HTML', () => {
  const routes = read('src/routes/community-invites.js');
  assert.match(routes, /if \(preview\.live\) countOpen\(req, res, req\.params\.token\);/);
  // The signed-in read is also the invite funnel's "signed in" step for the
  // admin Journey (journey-events.noteInviteSignedIn, once per person per link).
  assert.match(routes, /if \(standing\.live && !standing\.mine\) \{\s*countOpen\(req, res, req\.params\.token, req\.user\.id\);\s*void journeyEvents\.noteInviteSignedIn\(pool, \{ token: req\.params\.token, userId: req\.user\.id \}\);\s*\}/);
  // Every read is handed to the service with the browser it came from; the
  // service decides whether it is somebody new (invite-activity-postgres).
  // The read also carries where the visitor came from (#6540) into the same
  // service call, so the open keeps its referrer host and via tag.
  assert.match(routes, /const browser = inviteActivity\.ensureBrowser\(req, res\);\s*const source = inviteActivity\.sourceFrom\(req\);\s*void inviteActivity\.noteOpened\(pool, \{ token, viewerId, browser, seenBefore, source \}\);/);
  const page = routes.slice(routes.indexOf("router.get('/invite/:token'"));
  assert.doesNotMatch(page, /countOpen/);
  assert.match(page, /inviteActivity\.ensureBrowser\(req, res\);/, 'the page sets the browser before its two reads race');
  // A join is told with the browser it came from, so an open made signed
  // out in that browser is replaced by it.
  assert.match(routes, /token: req\.params\.token, user: req\.user, browser: inviteActivity\.browserFrom\(req\),/);
  const service = read('src/services/community-invites.js');
  assert.match(service, /void require\('\.\/invite-activity'\)\.noteJoined\(pool, \{ inviteId: invite\.id, user, browser \}\);/);
  assert.match(service, /const browser = require\('\.\/invite-activity'\)\.browserFrom\(req\);\s*const result = await redeem\(pool, \{ token, user, browser, requirePhone \}\);/);
  // Not awaited where it starts: the small-group discussion ring waits for it
  // later, so the maker is not told about the same message twice
  // (services/group-channel-notify.js).
  assert.match(read('src/services/ws.js'),
    /const hello = postedVia !== 'agent'\s*\? require\('\.\/invite-activity'\)\.noteFirstMessage\(pool, \{/);
});
