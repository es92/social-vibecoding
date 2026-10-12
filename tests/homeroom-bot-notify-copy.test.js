'use strict';

// "One request, one story": what the Homeroom bot's push, bell row and ready
// email say (src/services/homeroom-bot-notify-copy.js), from the metadata on
// the bot's DM message alone, for every moment and variant of the shared
// contract, and for rows written before it (`hrbot:<said>:<app>`).
//
// Run with: node --test tests/homeroom-bot-notify-copy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const copy = require('../src/services/homeroom-bot-notify-copy');
const templates = require('../src/services/mail/templates');

const BASE = { appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, requestTitle: 'Dark mode', threadRootId: 77 };
const words = (metadata) => copy.botMomentCopy(copy.botNotificationDetail({ ...BASE, ...metadata }));

// Section 2.2's push bodies, by `said`.
const BODIES = [
  ['needs_you', 'question', {}, 'I have a question before I build it.'],
  ['needs_you', 'questions', {}, 'I have two questions before I build it.'],
  ['needs_you', 'followup_ask', {}, 'I have a question before I update it.'],
  ['needs_you', 'plan', {}, 'My plan is ready. Tap Build it if it looks right.'],
  ['needs_you', 'decide', {}, 'This needs your decision before I build it.'],
  ['needs_you', 'decide_others', { deciders: '@ada and @ben' }, 'This needs a decision from @ada and @ben before I build it.'],
  ['needs_you', 'blocked', {}, 'I can\'t build it as written. Add detail and I\'ll look again.'],
  ['needs_you', 'empty', {}, 'I couldn\'t find anything to build. Add detail and I\'ll look again.'],
  ['needs_you', 'done', {}, 'This looks done already. Close it, or tell me what\'s missing.'],
  ['needs_you', 'platform', {}, 'This is about Homeroom itself. Move it to Homeroom\'s own board?'],
  ['ready', 'ready', {}, 'Ready to try. Try it, and approve it if you\'re happy.'],
  ['ready', 'ready_group', { waiting: 'you and @ada' }, 'Ready to try. It goes live once you and @ada say yes.'],
  ['ready', 'ready_group', { waiting: '@ada' }, 'Ready to try. It needs one more yes, from @ada.'],
  ['ready', 'ready_broken', { ready: { broken: ['Search'] } }, 'Built, but one thing isn\'t working yet. Try it to see.'],
  ['ready', 'ready_broken', { ready: { broken: ['Search', 'Sort', 'Filter'] } }, 'Built, but 3 things aren\'t working yet. Try it to see.'],
  ['stopped', 'build_time', {}, 'Stopped: it took longer than I\'m allowed. Tap Try again.'],
  ['stopped', 'build_restart', {}, 'Stopped: Homeroom restarted while I was building. Tap Try again.'],
  ['stopped', 'build_no_change', {}, 'Stopped: I ended up with no changes to show. Tap Try again.'],
  ['stopped', 'build_not_proposed', {}, 'Stopped: I built it but couldn\'t put it up for a vote. Tap Try again.'],
  ['stopped', 'build_no_start', {}, 'Stopped: I couldn\'t get started. Tap Try again.'],
  ['stopped', 'build_other', {}, 'Stopped: something went wrong while I was building. Tap Try again.'],
  ['stopped', 'update_failed', {}, 'Stopped: I couldn\'t update it. It\'s as it was.'],
  ['stopped', 'needs_look', {}, 'Stopped: it\'s built, but a person needs to look at it before you can try it.'],
  ['stopped', 'checks', {}, 'Stopped: its checks still fail. A person needs to look.'],
  ['on_hold', 'allowance', {}, 'On hold until Monday: your building time for this week is used up.'],
  ['on_hold', 'paused', {}, 'On hold until Monday: I\'ve used my budget for this week.'],
  ['live', 'live', {}, 'It\'s live. Open Plant Pal to see it.'],
  ['live', 'live_soon', {}, 'It\'s going live now. Open Plant Pal in a few minutes to see it.'],
];

const FIRST_VERSION = [
  ['needs_you', 'plan_first', 'My plan for your first version is ready. Tap Build it if it looks right.'],
  ['ready', 'ready_first', 'Your first version is ready to try.'],
  ['stopped', 'first_failed', 'Stopped: I couldn\'t start building your first version. You can still post a request on its page.'],
  ['live', 'live_first', 'Your first version is live. Open Plant Pal to try it.'],
  ['live', 'live_first_soon', 'Your first version is going live now. Open Plant Pal in a few minutes to try it.'],
];

const LABELS = { needs_you: 'Needs you', ready: 'Ready to try', stopped: 'Stopped', on_hold: 'On hold', live: 'Live' };

test('every variant of the contract is worded, with the request and its project as the title', () => {
  const covered = new Set();
  for (const [moment, said, extra, body] of BODIES) {
    const got = words({ moment, said, ...extra });
    assert.equal(got.body, body, `${moment}/${said}`);
    assert.equal(got.title, 'Dark mode · Plant Pal', `${moment}/${said}`);
    assert.equal(got.bellLabel, LABELS[moment], `${moment}/${said}`);
    assert.equal(got.bellSubject, 'Dark mode', `${moment}/${said}`);
    assert.equal(got.bellMeta, 'Plant Pal · Homeroom bot', `${moment}/${said}`);
    assert.equal(got.threadRootId, 77, 'the tap opens the request\'s thread');
    covered.add(said);
  }
  for (const [moment, said, body] of FIRST_VERSION) {
    const got = words({ moment, said, firstVersion: true, requestTitle: null });
    assert.equal(got.body, body, said);
    assert.equal(got.title, 'Plant Pal', `${said}: a first version is titled by its project`);
    assert.equal(got.bellSubject, 'Plant Pal first version', said);
    covered.add(said);
  }
  for (const [moment, saids] of Object.entries(copy.SAID_BY_MOMENT)) {
    for (const said of saids) assert.ok(covered.has(said), `${moment}/${said} is pinned here`);
  }
});

test('nothing it says names a proposal, a PR, an issue, or the bot\'s handle', () => {
  for (const [moment, said, extra] of BODIES) {
    const got = words({ moment, said, ...extra });
    assert.doesNotMatch(`${got.title} ${got.body} ${got.bellLabel}`, /proposal|pull request|\bPR\b|issue|@homeroom_bot|merged|shipped/i);
  }
});

test('the weekly hold summary is one message with its count', () => {
  const several = words({ moment: 'on_hold', said: 'allowance', count: 3 });
  assert.equal(several.title, '3 requests on hold');
  assert.equal(several.bellSubject, '3 requests on hold');
  assert.equal(several.body, 'On hold until Monday: your building time for this week is used up.');
  assert.equal(words({ moment: 'on_hold', said: 'allowance', count: 1 }).title, 'Dark mode · Plant Pal');
});

test('a sender that names only the moment and its kind still gets the right variant', () => {
  const said = (meta) => copy.parseBotDetail(copy.botNotificationDetail({ ...BASE, ...meta })).said;
  assert.equal(said({ moment: 'needs_you', kind: 'plan' }), 'plan');
  assert.equal(said({ moment: 'needs_you', kind: 'plan', firstVersion: true }), 'plan_first');
  assert.equal(said({ moment: 'needs_you', kind: 'question', questions: [{}, {}] }), 'questions');
  assert.equal(said({ moment: 'ready', kind: 'proposal' }), 'ready');
  assert.equal(said({ moment: 'ready', kind: 'proposal', group: true }), 'ready_group');
  assert.equal(said({ moment: 'ready', kind: 'proposal', firstVersion: true }), 'ready_first');
  assert.equal(said({ moment: 'stopped', kind: 'build_failed' }), 'build_other');
  assert.equal(said({ moment: 'stopped', kind: 'build_failed', cause: 'timeout' }), 'build_time');
  assert.equal(said({ moment: 'stopped', kind: 'followup_failed' }), 'update_failed');
  assert.equal(said({ moment: 'live', kind: 'merged', live: false }), 'live_soon');
  // The older moment names, and a request it cannot build rung as a stop.
  assert.equal(copy.parseBotDetail(copy.botNotificationDetail({ moment: 'question', kind: 'question' })).moment, 'needs_you');
  assert.equal(copy.parseBotDetail(copy.botNotificationDetail({ moment: 'held', kind: 'paused' })).said, 'paused');
  const blocked = copy.parseBotDetail(copy.botNotificationDetail({ moment: 'stopped', kind: 'blocked' }));
  assert.deepEqual([blocked.moment, blocked.said], ['needs_you', 'blocked']);
  // A variant from another moment is not taken on trust.
  assert.equal(said({ moment: 'live', said: 'ready' }), 'live');
});

test('a quiet message carries no detail, and an answer keeps its old token', () => {
  assert.equal(copy.botNotificationDetail({ ...BASE, moment: null }), null);
  assert.equal(copy.botNotificationDetail({ ...BASE }), null);
  assert.equal(copy.botNotificationDetail({ ...BASE, moment: 'nonsense' }), null);
  assert.equal(copy.botNotificationDetail({ moment: 'reply' }), 'hrbot:reply:');
  const reply = copy.botMomentCopy('hrbot:reply:', 'Yes, **Pin notes** is up.');
  assert.deepEqual([reply.title, reply.body], ['Homeroom bot', 'Yes, Pin notes is up.']);
});

test('the detail fits its column whatever it is given, and a broken one reads as nothing', () => {
  const long = 'x'.repeat(5000);
  const detail = copy.botNotificationDetail({
    moment: 'needs_you', said: 'decide_others', appName: long, requestTitle: long, waiting: long, deciders: long, threadRootId: 2147483647,
  });
  assert.ok(detail.length <= 1200, `${detail.length} chars`);
  assert.equal(copy.botMomentCopy('hrbot2:{not json'), null);
  assert.equal(copy.botMomentCopy('hrbot2:{"m":"nope"}'), null);
  assert.equal(copy.botMomentCopy('hrbot:nonsense:X'), null);
  assert.equal(copy.botMomentCopy(null), null);
});

test('rows written before "one story" keep reading, as the moments they are', () => {
  const legacy = [
    ['hrbot:question:Plant Pal', 'Needs you', 'I have a question before I build it.'],
    ['hrbot:ready:Plant Pal', 'Ready to try', 'Ready to try. Try it, and approve it if you\'re happy.'],
    ['hrbot:ready_group:Supper Club', 'Ready to try', 'Ready to try. It goes live once the group says yes.'],
    ['hrbot:ready_broken:Flat 4B Chores', 'Ready to try', 'Built, but something isn\'t working yet. Try it to see.'],
    ['hrbot:stopped:Plant Pal', 'Stopped', 'Stopped: I couldn\'t update it. It\'s as it was.'],
    ['hrbot:stopped_build:Plant Pal', 'Stopped', 'Stopped: something went wrong while I was building. Tap Try again.'],
    ['hrbot:stopped_blocked:Plant Pal', 'Needs you', 'I can\'t build it as written. Add detail and I\'ll look again.'],
    ['hrbot:stopped_person:Plant Pal', 'Needs you', 'This needs your decision before I build it.'],
    ['hrbot:stopped_empty:Plant Pal', 'Needs you', 'I couldn\'t find anything to build. Add detail and I\'ll look again.'],
    ['hrbot:stopped_first:Plant Pal', 'Stopped', 'Stopped: I couldn\'t start building your first version. You can still post a request on its page.'],
    ['hrbot:stopped_preview:Plant Pal', 'Stopped', 'Stopped: it\'s built, but a person needs to look at it before you can try it.'],
    ['hrbot:stopped_look:Plant Pal', 'Stopped', 'Stopped: it\'s built, but a person needs to look at it before you can try it.'],
    ['hrbot:held:Plant Pal', 'On hold', 'On hold until Monday: your building time for this week is used up.'],
    ['hrbot:held:', 'On hold', 'On hold until Monday: I\'ve used my budget for this week.'],
    ['hrbot:live:Plant Pal', 'Live', 'It\'s live. Open Plant Pal to see it.'],
    ['hrbot:live_soon:Plant Pal', 'Live', 'It\'s going live now. Open Plant Pal in a few minutes to see it.'],
    ['hrbot:live_first:Plant Pal', 'Live', 'Your first version is live. Open Plant Pal to try it.'],
    ['hrbot:live_first_soon:Plant Pal', 'Live', 'Your first version is going live now. Open Plant Pal in a few minutes to try it.'],
  ];
  const pinned = new Set([...legacy.map(([d]) => d.split(':')[1]), 'reply']);
  assert.deepEqual([...pinned].sort(), Object.keys(copy.LEGACY_SAID).sort(), 'every old token (and reply) is pinned');
  for (const [detail, label, body] of legacy) {
    const got = copy.botMomentCopy(detail);
    assert.ok(got, detail);
    assert.deepEqual([got.bellLabel, got.body], [label, body], detail);
    assert.ok(copy.isBotMomentDetail(detail), detail);
  }
  assert.equal(copy.botMomentCopy('hrbot:ready:Plant Pal').title, 'Plant Pal', 'no title on an old row: the project');
  assert.equal(copy.botMomentCopy('hrbot:live_first:Plant Pal').bellSubject, 'Plant Pal first version');
  assert.equal(copy.isBotMomentDetail('hrbot:reply:'), false);
});

test('each moment rings as its kind in "Your builds"; an answer stays a message', () => {
  assert.deepEqual(
    ['needs_you', 'ready', 'stopped', 'on_hold', 'live', 'question', 'held', 'reply', null].map(copy.momentKind),
    ['build_needs_you', 'build_ready', 'build_stopped', 'build_stopped', 'build_live', 'build_needs_you', 'build_stopped', null, null],
  );
});

test('the ready email says what the push says, and opens the thread', () => {
  const detail = copy.botNotificationDetail({ ...BASE, moment: 'ready', said: 'ready' });
  const email = copy.botEmailCopy(detail);
  assert.deepEqual(email, {
    subject: 'Dark mode · Plant Pal: Ready to try',
    lead: 'Ready to try. Try it, and approve it if you\'re happy.',
  });
  const first = copy.botEmailCopy(copy.botNotificationDetail({ ...BASE, moment: 'ready', said: 'ready_first', firstVersion: true }));
  assert.equal(first.subject, 'Plant Pal: Your first version is ready to try');
  // A group project is named by its request now, never "Your change to".
  const group = copy.botEmailCopy(copy.botNotificationDetail({ ...BASE, moment: 'ready', said: 'ready_group', waiting: '@ada' }));
  assert.equal(group.subject, 'Dark mode · Plant Pal: Ready to try');
  assert.doesNotMatch(group.subject, /Your change to/);

  const message = templates.buildMessage('build_ready', {
    to: 'maya@example.invalid', appName: 'Plant Pal', ...email,
    url: 'https://app.onhomeroom.com/#messages/9/thread/77', unsubscribeUrl: 'https://app.onhomeroom.com/mail/unsubscribe?u=1&t=x',
  });
  assert.equal(message.subject, 'Dark mode · Plant Pal: Ready to try');
  assert.match(message.text, /^Ready to try\. Try it, and approve it if you're happy\.\n\nOpen it: https:\/\/app\.onhomeroom\.com\/#messages\/9\/thread\/77/);
  // A sender that hands over no words gets the same shape from the project.
  const bare = templates.buildMessage('build_ready', { to: 'x@example.invalid', appName: 'Plant Pal', url: 'https://x' });
  assert.equal(bare.subject, 'Plant Pal: Ready to try');
  const broken = templates.buildMessage('build_ready', { to: 'x@example.invalid', appName: 'Plant Pal', url: 'https://x', notWorking: true });
  assert.equal(broken.subject, 'Plant Pal: Built, but something isn\'t working yet');
});

test('the email\'s button opens the request\'s thread, or the message, or the chat', () => {
  const mail = require('../src/services/activity-mail');
  assert.match(mail.openUrl({ conversationId: 9, threadRootId: 77, messageId: 80 }), /\/#messages\/9\/thread\/77$/);
  assert.match(mail.openUrl({ conversationId: 9, messageId: 80 }), /\/#messages\/9\/m\/80$/);
  assert.match(mail.openUrl({ conversationId: 9 }), /\/#messages\/9$/);
  assert.match(mail.openUrl({ appSlug: 'plant-pal' }), /\/app\/plant-pal$/);
});
