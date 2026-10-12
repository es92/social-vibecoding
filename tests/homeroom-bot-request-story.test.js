'use strict';

// One request, one story: what Homeroom bot says on a request's page and its
// change's page (src/services/homeroom-bot-live.js, homeroom-bot-followup.js,
// homeroom-bot-words.js). Others see the same story as the requester: the
// plan in a line, the change when it is up for a vote, and a closing line
// when it is live, in the first person and in whole sentences. A tag means
// the bot is asking you something; progress is said untagged.
//
// Run with: node --test tests/homeroom-bot-request-story.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const { firstPerson } = require('../src/services/homeroom-bot-words');

const SPEC = '# Dark mode\n\nA dark theme.';
const BOT = { id: 1, username: 'homeroom_bot' };

test('a plan row is the bot\'s sentence: building it now, or waiting for its requester', () => {
  const building = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT });
  assert.equal(building.content, '📋 Plan v1: Dark mode. I\'m building it now.');
  assert.equal(building.metadata.specShare.botNote, 'building');
  assert.equal(building.metadata.specShare.waitingFor, undefined);
  const asking = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT, asking: true, requester: 'sam' });
  assert.equal(asking.content, '📋 Plan v1: Dark mode. Waiting for @sam to say Build it.');
  assert.equal(asking.metadata.specShare.botNote, 'waiting');
  assert.equal(asking.metadata.specShare.waitingFor, 'sam');
  assert.equal(live.specCard({ sessionId: 7, version: 2, spec: SPEC, bot: BOT, asking: true }).content,
    '📋 Plan v2: Dark mode. Waiting for the person who asked for it to say Build it.');
  // On its change: the plan itself.
  const proposed = live.specCard({ sessionId: 7, version: 1, spec: SPEC, bot: BOT, proposed: true });
  assert.equal(proposed.content, '📋 Plan v1: Dark mode.');
  assert.equal(proposed.metadata.specShare.botNote, undefined);
});

test('a plan its requester said Build it to gets a short note, not a second card', () => {
  assert.equal(live.approvedBuildHomeroomText({ requester: 'sam' }), '@sam said Build it. I\'m building it now.');
  assert.equal(live.approvedBuildHomeroomText({}), 'The person who asked for it said Build it. I\'m building it now.');
  // GitHub's copy names nobody (#723) and promises no later link.
  const github = live.specCommentText(SPEC, { approved: true });
  assert.doesNotMatch(github, /@|linked here/);
  assert.doesNotMatch(live.specCommentText(SPEC), /linked here/);
  assert.doesNotMatch(live.retryCommentText(), /linked here/);
});

test('built: "I built this. It\'s up for a vote: {title}", no pull request number', () => {
  assert.equal(live.proposalHomeroomText({ title: 'Dark mode' }), 'I built this. It\'s up for a vote: Dark mode');
  assert.equal(live.proposalText({ link: 'https://homeroom.example/plant-pal/dev/changes/12', prNumber: 12 }),
    'Homeroom bot built this. It\'s up for a vote: https://homeroom.example/plant-pal/dev/changes/12');
  assert.doesNotMatch(live.proposalHomeroomText({ title: 'Dark mode' }), /PR #|proposal/);
});

test('live, the request\'s ending: "It\'s live. {title} is in {project} now."', () => {
  assert.equal(live.liveHomeroomText({ title: 'Dark mode', project: 'Plant Pal' }), 'It\'s live. Dark mode is in Plant Pal now.');
  assert.equal(live.liveText({ title: 'Dark mode' }), 'Homeroom bot\'s change for this is live: Dark mode.');
  assert.equal(live.tagsPoster('live'), false, 'not tagged');
});

function fakeLive({ posted = false, run = true } = {}) {
  const queries = [];
  const comments = [];
  const messages = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM homeroom_bot_runs r\s+JOIN apps a/.test(sql)) {
        return { rows: run ? [{ run_id: 40, app_id: 3, issue_number: 12, slug: 'plant-pal', name: 'Plant Pal', repo_url: 'https://github.com/o/plant-pal', title: 'Dark mode' }] : [] };
      }
      if (/kind = 'live' LIMIT 1/.test(sql)) return { rows: posted ? [{ '?column?': 1 }] : [] };
      if (/FROM users WHERE username/.test(sql)) return { rows: [BOT] };
      if (/INSERT INTO homeroom_bot_posts/.test(sql)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: { async createIssueComment(owner, repo, n, text) { comments.push({ owner, repo, n, text }); return { id: 5, created_at: 'now' }; } },
    ws: {
      async sendBotMessage(_pool, appId, msg) { messages.push({ appId, ...msg }); return { id: 77 }; },
      async sendSystemMessage() { throw new Error('the bot speaks as itself'); },
    },
  };
  return { pool, deps, queries, comments, messages };
}

test('announceLive says it on the request once, in both places, untagged', async () => {
  const f = fakeLive();
  const out = await live.announceLive(f.pool, { session: { id: 51 }, deps: f.deps });
  assert.ok(out && out.github && out.thread);
  assert.deepEqual(f.comments, [{ owner: 'o', repo: 'plant-pal', n: 12, text: 'Homeroom bot\'s change for this is live: Dark mode.' }]);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].content, 'It\'s live. Dark mode is in Plant Pal now.');
  assert.deepEqual(f.messages[0].thread, { type: 'issue', ref: 12 });
  const insert = f.queries.find((q) => /INSERT INTO homeroom_bot_posts/.test(q.sql));
  assert.deepEqual(insert.params, [3, 12, 40, 'live']);
  // Said already, or not the bot's change: nothing more.
  const again = fakeLive({ posted: true });
  assert.equal(await live.announceLive(again.pool, { session: { id: 51 }, deps: again.deps }), null);
  assert.equal(again.messages.length + again.comments.length, 0);
  const other = fakeLive({ run: false });
  assert.equal(await live.announceLive(other.pool, { session: { id: 51 }, deps: other.deps }), null);
  assert.equal(await live.announceLive(other.pool, { session: null }), null);
});

test('only what asks people something tags them', () => {
  for (const kind of ['question', 'person', 'followup_ask']) assert.equal(live.tagsPoster(kind), true, kind);
  for (const kind of ['spec', 'plan', 'proposal', 'build_failed', 'blocked', 'empty', 'followup_answer',
    'followup_revise', 'followup_person', 'followup_failed', 'looking', 'held_proposals_per_app']) {
    assert.equal(live.tagsPoster(kind), false, kind);
  }
});

test('held: one of my changes on the project, or the daily limit, in whole sentences', () => {
  assert.equal(firstPerson(live.heldText({ cap: 'proposals_per_app', limit: 3, project: 'Plant Pal' })),
    'I\'ll build this when one of my 3 changes on Plant Pal is voted in or closed.');
  assert.equal(firstPerson(live.heldText({ cap: 'proposals_total', limit: 40 })),
    'I\'ll build this when one of my 40 changes across Homeroom is voted in or closed.');
  assert.equal(firstPerson(live.heldText({ cap: 'question_tripwire', verdict: 'question', limit: 10, project: 'Plant Pal' })),
    'I have a question about this request, but I\'ve already posted 10 questions and notes on Plant Pal today. '
    + 'I\'ll come back to it once some of those are a day old.');
});

test('decide: who can say Go ahead is named in Homeroom, and nobody on GitHub', () => {
  assert.equal(live.personHomeroomText({ reason: 'It changes who can sign in', requester: 'sam' }),
    'I think a person needs to decide this one: It changes who can sign in. @sam can say Go ahead in a chat with me, or reply here.');
  assert.equal(live.personHomeroomText({ reason: 'x.', deciders: ['ada', 'bo'] }),
    'I think a person needs to decide this one: x. @ada or @bo can say Go ahead in a chat with me, or reply here.');
  assert.doesNotMatch(live.personText({ reason: 'x' }), /@/);
  assert.equal(firstPerson(live.personText({ reason: 'It is a platform setting', platform: true, project: 'Plant Pal' })),
    'I think this is about Homeroom itself, not Plant Pal: It is a platform setting.\n\n'
    + 'Whoever asked for it, or Plant Pal\'s creator or admins, can have me move it to Homeroom\'s own board.');
});

test('the checks hand-off says why in whole sentences, in the first person', () => {
  const said = (why, failingCount = 2) => firstPerson(followup.checksPersonText({ why, failingCount }));
  assert.match(said('it has already updated this change 3 times, as many as it may on its own'),
    / I've already updated it 3 times, as many as I may on my own\. A person/);
  assert.match(said('its attempt to fix them ran out of time'), / My attempt to fix them ran out of time\. A person/);
  assert.match(said('its attempt to fix them failed (exit 2)'), / My attempt to fix them failed \(exit 2\)\. A person/);
  assert.match(said('its attempt to fix them changed nothing'), / My attempt to fix them changed nothing\. A person/);
  assert.match(said('the seed data is missing'), / The seed data is missing\. A person/);
  assert.equal(firstPerson(followup.checksNotChangeText({ failingCount: 1 })),
    'The failing check on this change isn\'t caused by it: it fails without it too. I\'ve flagged it to Homeroom\'s admins, who look after the checks.');
  assert.match(followup.checksNotChangeText({ failingCount: 3 }), /^The failing checks on this change aren't caused by it: they fail without it too\./);
  assert.equal(firstPerson(followup.replyFailedText({ why: 'it ran out of time', retrying: true })),
    'I couldn\'t answer this time: I ran out of time. I\'ll try again soon.');
});

test('one note per update: the bot\'s own notes leave the cleared votes to the platform\'s line', () => {
  assert.doesNotMatch(followup.revisedText({ summary: 'Moved the bar.' }), /approvals|votes/i);
  for (const opts of [{}, { broken: true, failing: false }, { skipped: true, failing: false }]) {
    assert.doesNotMatch(followup.checksRevisedText({ summary: 'Fixed it.', ...opts }), /approvals|votes/i);
  }
  const voice = require('../src/services/homeroom-bot-voice');
  assert.deepEqual(voice.mustSay({ action: 'revise', moved: true }), []);
});
