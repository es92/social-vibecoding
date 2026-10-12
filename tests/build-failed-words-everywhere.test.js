'use strict';

// A build Homeroom bot could not finish is said the same plain way wherever
// it is said (5 Oct 2026, Page Turners #3).
//
// The requester's DM said "I tried to build this but couldn't finish (the
// build ran past its time limit (finished after a restart)). A person can pick
// it up from here." #3895 fixed the DM: what happened in plain words
// (homeroom-bot-dm.js buildFailedWords) and "Reply here and I'll try again."
// Three places still had the old words:
//
//   - the bot's post on the request, which everybody in the project reads
//     (and its GitHub comment): "Homeroom bot tried to build this but
//     couldn't finish: <the run's own record>. A person could pick it up from
//     here." (homeroom-bot-live.js buildFailedText);
//   - the push for that DM, and its bell row: "Stopped: something went wrong
//     while I was building. Tap Try again." (homeroom-bot-notify-copy.js,
//     which the push and the bell both read; tests/homeroom-bot-notify.test.js
//     holds the two together).
//
// Pinned here: the post says each cause as the DM does, from the same reading
// of the run's record, never the record itself; it says how anybody starts it
// again, and that is true (a person's reply there is activity the bot reads
// again: homeroom-bot.js classifyIssue); the push and the bell row end as the
// DM ends; and no failure surface says "pick it up" any more.
//
// Run with: node --test tests/build-failed-words-everywhere.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');
const policy = require('../src/services/mobile-push-policy');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DASH = /—/;
const RETRY = 'Reply here (or on the GitHub issue) and it will try again.';

// The run's own records (homeroom-bot.js, homeroom-bot-live.js), and what the
// DM and the post on the request each say about it.
const CAUSES = [
  ['the build ran past its time limit (finished after a restart)',
    'I couldn\'t finish building this: it took longer than I\'m allowed.',
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed.'],
  ['the build ran past its time limit; last activity: npm test',
    'I couldn\'t finish building this: it took longer than I\'m allowed.',
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed.'],
  ['the platform restarted in the middle of each of its last 3 tries at building this',
    'I couldn\'t finish building this: Homeroom restarted while I was working on it, 3 times in a row.',
    'Homeroom bot couldn\'t finish building this: Homeroom restarted in the middle of the build, 3 times in a row.'],
  [bot.ABANDONED_LIVE_REASON,
    'I couldn\'t finish building this: Homeroom restarted while I was working on it.',
    'Homeroom bot couldn\'t finish building this: Homeroom restarted in the middle of the build.'],
  ['the build produced no change to propose (finished after a restart)',
    'I couldn\'t finish building this: I ended up with no changes to show you.',
    'Homeroom bot couldn\'t finish building this: it ended up with no changes to show.'],
  ['the change was built but could not be proposed: checks unavailable',
    'I built this, but I couldn\'t put it up for approval.',
    'Homeroom bot built this, but couldn\'t put it up for approval.'],
  ['the build could not start (worker pool exhausted)',
    'I couldn\'t get started on building this.',
    'Homeroom bot couldn\'t get started on building this.'],
  ['the build turn failed (exit 1)',
    'I couldn\'t finish building this: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
  ['',
    'I couldn\'t finish building this: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
  [null,
    'I couldn\'t finish building this: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
];

test('the post on the request says what the DM says, about the bot, and how anybody starts it again', () => {
  for (const [reason, toThem, onRequest] of CAUSES) {
    assert.equal(dm.buildFailedWords(reason), toThem, `DM: ${reason}`);
    assert.equal(dm.buildFailedWords(reason, 'this', 'bot'), onRequest, `post: ${reason}`);
    assert.equal(live.buildFailedText(reason), `${onRequest} ${RETRY}`, `post: ${reason}`);
  }
  // The 5 October request, word for word.
  assert.equal(
    live.buildFailedText('the build ran past its time limit (finished after a restart)'),
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed. '
      + 'Reply here (or on the GitHub issue) and it will try again.',
  );
  // The DM's own words are unchanged by the second voice.
  assert.equal(dm.buildFailedWords('the build ran past its time limit', 'the first version'),
    'I couldn\'t finish building the first version: it took longer than I\'m allowed.');
  assert.equal(dm.buildFailedWords('x', 'this', 'someone else'), dm.buildFailedWords('x'), 'an unknown voice is the DM\'s');
});

test('the run\'s own record is never the sentence anybody reads', () => {
  for (const [reason] of CAUSES) {
    const text = live.buildFailedText(reason);
    assert.doesNotMatch(text, /\(finished|time limit|finished after|exit 1|worker pool|checks unavailable|last activity|npm test/, String(reason));
    assert.doesNotMatch(text, /pick it up|A person could|unknown reason/, String(reason));
    assert.doesNotMatch(text, DASH, String(reason));
  }
  // It stays where a maintainer looks: on the run (build_error, which the
  // admin's Homeroom bot screen shows) and in the log, beside the post.
  const src = read('src/services/homeroom-bot.js');
  const announce = src.slice(src.indexOf('async function announceBuilt('), src.indexOf('async function actOnVerdict('));
  assert.match(announce, /await recordLiveBuild\(pool, runId, built/);
  assert.match(announce, /log\.warn\('homeroom-bot', 'Live build did not become a proposal', \{[\s\S]*?error: built\.error/);
  assert.match(announce, /say\('build_failed', live\.buildFailedText\(built\.error\), \{ dm: \{ reason: built\.error \} \}\)/);
  assert.match(read('frontend/src/features/admin/admin-homeroom-bot.tsx'), /Live build did not become a proposal: \$\{why\}\./);
});

test('"Reply here (or on the GitHub issue)" is true: a person\'s word on the request has the bot read it again', () => {
  const failedAt = '2026-10-05T10:00:00.000Z';
  const lastRun = { thread_seen_at: failedAt, verdict: 'ready', mode: 'live', live_building: false };
  const issue = { number: 3, state: 'open', createdAt: '2026-10-05T09:00:00.000Z', updatedAt: failedAt };
  // Nothing new since the failed build: it waits.
  assert.equal(bot.classifyIssue({ issue, lastRun }).reason, 'unchanged');
  // A reply in its Homeroom discussion (threadActivityByIssue counts people only).
  const here = bot.classifyIssue({ issue, threadLastAt: '2026-10-05T10:05:00.000Z', lastRun });
  assert.deepEqual([here.eligible, here.reason], [true, 'changed']);
  // A comment on the GitHub issue moves its updated time.
  const there = bot.classifyIssue({ issue: { ...issue, updatedAt: '2026-10-05T10:06:00.000Z' }, lastRun });
  assert.deepEqual([there.eligible, there.reason], [true, 'changed']);
  // And a person's message there wakes the bot at once (ws.js), not on its next pass.
  assert.match(read('src/services/ws.js'), /if \(thread && thread\.type === 'issue'\) noteIssueActivityForBot\(client\.appId, thread\.ref, 'thread'\);/);
});

test('the push and the bell row for the DM say it stopped and how to start it again', async () => {
  const pool = { async query() { return { rows: [] }; } };
  const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
  // "One story" (section 2.2): a stopped build's push names the request and
  // its project, and ends with what starts it again (the DM's Try again).
  const metadata = { kind: 'build_failed', appName: 'Page Turners', requestTitle: 'Display location and host information' };
  const detail = await dm.notificationDetail(pool, dm.momentOf(metadata), metadata);
  const parsed = notifyCopy.parseBotDetail(detail);
  assert.deepEqual([parsed.moment, parsed.said], ['stopped', 'build_other']);
  const copy = policy.buildNotificationCopy('build_stopped', {
    sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail, messageContent: 'x',
  });
  assert.deepEqual(copy, {
    title: 'Display location and host information · Page Turners',
    body: 'Stopped: something went wrong while I was building. Tap Try again.',
  });
  // A sender that says which stop it was is worded by it.
  const timedOut = await dm.notificationDetail(pool, 'stopped', { ...metadata, said: 'build_time' });
  assert.equal(notifyCopy.botMomentCopy(timedOut).body, 'Stopped: it took longer than I\'m allowed. Tap Try again.');
  const said = dm.dmText('build_failed', { reason: 'the build ran past its time limit (finished after a restart)' },
    { appName: 'Page Turners', issueNumber: 3, issueTitle: 'Display location and host information', firstVersion: false });
  assert.match(said, /try again/i, 'the DM it opens says how to start it again too');
  assert.match(copy.body, /Try again\.$/);
});

test('no failure surface says "pick it up" any more', () => {
  for (const rel of ['src/services/homeroom-bot-live.js', 'src/services/mobile-push-policy.js',
    'frontend/src/features/notifications/notifications.js']) {
    const code = read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /A person (?:can|could) pick it up/, rel);
  }
});
