'use strict';

// An update Homeroom bot could not make to its own change is said plainly,
// with a real next step (5 Oct 2026).
//
// After "Ask for changes" or a reply on the change, a follow-up that said it
// revised but moved nothing posted, to everybody in the project: "Homeroom
// bot tried to update this change but couldn't: the turn produced no change.
// It is as it was. A person could make the update from here." The run's own
// record, and a dead end. #3900 fixed the same for a build
// (tests/build-failed-words-everywhere.test.js). Pinned here, the same way:
//   - the post (homeroom-bot-followup.js revisionFailedText) and the DM
//     (homeroom-bot-dm.js dmText 'followup_failed') say the cause in the same
//     words, from the same reading of the record (buildFailedCause, through
//     updateFailedWords), and never the record itself;
//   - the next step each names is true: a reply in the change's discussion
//     or on the request wakes the bot (ws.js), and its next look is a
//     follow-up that reads that reply; Ask for changes on the change posts
//     what they write there and puts that follow-up first;
//   - a change it may not revise again says so, instead of a retry that
//     would not happen;
//   - the DM carries the change's card and rings as a stop.
//
// Run with: node --test tests/homeroom-bot-revision-failed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dm = require('../src/services/homeroom-bot-dm');
const followup = require('../src/services/homeroom-bot-followup');
const policy = require('../src/services/mobile-push-policy');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DASH = /—/;
const RETRY = 'The change is as it was. Reply here (or on the GitHub issue) and it will try again.';

// The run's own records (homeroom-bot.js runFollowUp), and what the DM and
// the post on the change each say about it.
const CAUSES = [
  ['the turn produced no change',
    'I couldn\'t update your change: I ended up with no changes to show you.',
    'Homeroom bot couldn\'t update this change: it ended up with no changes to show.'],
  ['its change could not be pushed',
    'I couldn\'t update your change: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t update this change: something went wrong during the update.'],
  ['the turn failed (the agent exited with code 1), so its change was not kept',
    'I couldn\'t update your change: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t update this change: something went wrong during the update.'],
  ['the turn failed (it ended on an API error), so its change was not kept',
    'I couldn\'t update your change: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t update this change: something went wrong during the update.'],
  ['', 'I couldn\'t update your change: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t update this change: something went wrong during the update.'],
  [null, 'I couldn\'t update your change: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t update this change: something went wrong during the update.'],
];

const CONTEXT = { appName: 'Climbing Crew', issueNumber: 4, issueTitle: 'Say whether you can drive', firstVersion: false };
const LINE = '**Climbing Crew** · request #4: Say whether you can drive';

test('the post on the change and the DM say the same cause, each in its own voice', () => {
  for (const [why, toThem, onChange] of CAUSES) {
    assert.equal(dm.updateFailedWords(why, 'your change'), toThem, `DM: ${why}`);
    assert.equal(dm.updateFailedWords(why, 'this change', 'bot'), onChange, `post: ${why}`);
    assert.equal(followup.revisionFailedText({ why }), `${onChange} ${RETRY}`, `post: ${why}`);
  }
  // A cause only a build has is not said of an update.
  assert.equal(dm.updateFailedWords('the change was built but could not be proposed: x', 'your change'),
    'I couldn\'t update your change: something went wrong while I was working on it.');
  // The build's words are #3900's, unchanged by the second kind of work.
  assert.equal(dm.buildFailedWords('the build ran past its time limit (finished after a restart)'),
    'I couldn\'t finish building this: it took longer than I\'m allowed.');
  assert.equal(dm.buildFailedWords('the build produced no change to propose', 'this', 'bot'),
    'Homeroom bot couldn\'t finish building this: it ended up with no changes to show.');
  assert.equal(dm.failedWords('x', { it: 'it', voice: 'bot', doing: 'update' }),
    'Homeroom bot couldn\'t update it: something went wrong during the update.');
});

test('the run\'s own record is never the sentence anybody reads', () => {
  for (const [why] of CAUSES) {
    const post = followup.revisionFailedText({ why });
    const said = dm.dmText('followup_failed', { reason: why, sessionId: 5001 }, CONTEXT);
    for (const text of [post, said]) {
      assert.doesNotMatch(text, /\(the agent|\(it ended|turn|pushed|exited|API error|not kept|unknown reason/, String(why));
      assert.doesNotMatch(text, /A person could|from here/, 'no dead end');
      assert.doesNotMatch(text, DASH);
      assert.doesNotMatch(text, /proposal|vote|PR #/i, 'the change, in plain words');
    }
  }
  // It stays on the run (its error, which the admin's Homeroom bot screen
  // shows) and in the log, beside the post; the DM is handed it to read.
  const src = read('src/services/homeroom-bot.js');
  const failed = src.slice(src.indexOf('// Said it would revise, but the push moved nothing.'), src.indexOf('const action = moved ? \'revise\' : parsed.action;'));
  assert.match(failed, /verdict: 'failed', error: `revise: \$\{why\}`/);
  assert.match(failed, /log\.warn\('homeroom-bot', 'Follow-up said it revised, but the change did not move', \{[\s\S]*?why/);
  assert.match(failed, /say\('followup_failed', followup\.revisionFailedText\(\{ why, canRevise \}\), postedAt, \{\s*dm: \{ reason: why, canRevise, sessionId: session\.id, link: proposalUrl \},/);
});

// One story (contract 2.3): the chat's words say Change something, not Ask for changes.
test('in the DM: what happened, and Change something on the change to try again', () => {
  assert.equal(
    dm.dmText('followup_failed', { reason: 'the turn produced no change', sessionId: 5001 }, CONTEXT),
    `${LINE}\n\nI couldn't update your change: I ended up with no changes to show you. It's as it was. `
      + 'To try again, tap Change something on it below.',
  );
  // Its card is the change (cardsFor), the one "below" means.
  assert.deepEqual(dm.cardsFor('followup_failed', { sessionId: 5001 }, { id: 3 }, 4), [{ type: 'proposal', appId: 3, sessionId: 5001 }]);
  // Where the card cannot go, the address is the way to it; without either, the project names it.
  assert.equal(
    dm.dmText('followup_failed', { reason: 'x', link: 'https://app.onhomeroom.com/#app/climb/dev/proposals/5001' }, CONTEXT).split('\n\n')[1],
    'I couldn\'t update your change: something went wrong while I was working on it. It\'s as it was. '
      + 'To try again, open it and tap Change something: https://app.onhomeroom.com/#app/climb/dev/proposals/5001',
  );
  assert.equal(
    dm.dmText('followup_failed', { reason: 'x' }, CONTEXT).split('\n\n')[1],
    'I couldn\'t update your change: something went wrong while I was working on it. It\'s as it was. '
      + 'To try again, open it on Climbing Crew and tap Change something.',
  );
  // A first version is the first version.
  assert.match(dm.dmText('followup_failed', { reason: 'x', sessionId: 5001 }, { ...CONTEXT, firstVersion: true }),
    /\n\nI couldn't update the first version: something went wrong/);
  // One it may not revise again says so, with no retry that would not happen.
  const done = dm.dmText('followup_failed', { reason: 'the turn produced no change', canRevise: false, sessionId: 5001 }, CONTEXT);
  assert.equal(done.split('\n\n')[1], 'I couldn\'t update your change: I\'ve already updated it as many times as I can on my own, '
    + 'so a person needs to make this one. It\'s as it was.');
  assert.doesNotMatch(done, /try again/i);
  assert.equal(followup.revisionFailedText({ why: 'x', canRevise: false }),
    'Homeroom bot couldn\'t update this change: it has already updated it as many times as it may on its own, '
      + 'so a person needs to make this one. The change is as it was.');
});

test('the DM rings as a stop, in the stop\'s own words', async () => {
  assert.equal(dm.momentOf({ kind: 'followup_failed' }), 'stopped');
  const pool = { async query() { return { rows: [] }; } };
  const metadata = { kind: 'followup_failed', appName: 'Climbing Crew' };
  const detail = await dm.notificationDetail(pool, dm.momentOf(metadata), metadata);
  assert.equal(detail, 'hrbot:stopped:Climbing Crew');
  const copy = policy.buildNotificationCopy('build_stopped', {
    sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail, messageContent: 'x',
  });
  assert.deepEqual(copy, { title: 'Homeroom bot', body: 'Climbing Crew: your change stopped. I said why in our chat' });
});

test('"Reply here (or on the GitHub issue)" is true: a reply there is read by the next follow-up', () => {
  // A person's message in the change's discussion or on the request wakes the bot (ws.js) ...
  const ws = read('src/services/ws.js');
  assert.match(ws, /if \(thread && thread\.type === 'issue'\) noteIssueActivityForBot\(client\.appId, thread\.ref, 'thread'\);/);
  assert.match(ws, /if \(thread && thread\.type === 'session'\) noteProposalActivityForBot\(pool, client\.appId, thread\.ref\);/);
  // ... and the next look at a request with the bot's change up is a follow-up,
  // which reads what people said since the failed run, wherever they said it.
  const failedAt = Date.parse('2026-10-05T10:00:00Z');
  const replies = followup.newReplies({
    comments: [{ author: 'sam', body: 'Try again please', createdAt: '2026-10-05T10:06:00Z' }],
    issueThread: [{ author: 'homeroom_bot', body: 'Homeroom bot couldn\'t update this change', createdAt: '2026-10-05T10:01:00Z' }],
    proposalThread: [{ author: 'sam', body: 'Green, please', createdAt: '2026-10-05T10:05:00Z' }],
    botLogin: 'usernode-bot', botUsername: 'homeroom_bot', sinceMs: failedAt,
  });
  assert.deepEqual(replies.map((r) => [r.where, r.body]), [['proposal', 'Green, please'], ['issue', 'Try again please']],
    'the bot\'s own post is not a reply; a person\'s, here or on GitHub, is');
  const bot = read('src/services/homeroom-bot.js');
  assert.match(bot, /if \(open\.status === 'promoted'\) \{\s*followUpTurn = true;\s*return runFollowUp\(pool, config, \{/,
    'a request with the bot\'s change up for a vote is followed up, not triaged again');
});

test('"Ask for changes" is true: it posts on the change and puts its follow-up first', () => {
  // On a change the bot built, the change page leads with it ...
  const view = read('public/js/app-view.js');
  assert.match(view, /label: PlatformI18n\.t\('changes:page\.menu\.askForChanges'\), icon: 'generate',/);
  assert.equal(require('./lib/platform-i18n').message('changes:page.menu.askForChanges'), 'Ask for changes');
  // ... which opens the bot's chat with the change attached, and a message
  // carrying it is sent to the change, not to the model to guess at.
  const dmSrc = read('src/services/homeroom-bot-dm.js');
  assert.match(dmSrc, /const revised = await mayor\.reviseAttached\(pool, config, \{ bot, user, settings, conversationId, message, deps: turnDeps \}\);/);
  const mayor = read('src/services/homeroom-bot-mayor.js');
  const revise = mayor.slice(mayor.indexOf('async function reviseProposal('), mayor.indexOf('async function attachedPendingChange('));
  assert.match(revise, /await dm\.postOnProposal\(pool, \{/);
  const post = dmSrc.slice(dmSrc.indexOf('async function postOnProposal('), dmSrc.indexOf('async function answerOnRequest('));
  assert.match(post, /thread: \{ type: 'session', ref: Number\(sessionId\) \}/);
  assert.match(post, /enqueueFront\(pool, \{/);
});
