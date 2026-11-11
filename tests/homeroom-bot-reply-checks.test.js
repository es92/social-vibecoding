'use strict';
// #6583: a reply is checked against the bot's stored records, not only what
// this turn's tools did. A true sentence about an earlier turn, or about work
// another part of the bot is doing, stays; a claim is cut only when the
// records show it is false, and the note asks for a lookup rather than a
// retraction.
const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');

/**
 * A pool answering each SQL by the first matching route. A test names only
 * the rows its own query needs.
 */
function pool(routes = []) {
  return {
    query: async (sql, params = []) => {
      for (const [re, rows] of routes) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
}

/** The reads storedClaimFacts makes, each answered by its own route. */
function records(opts = {}) {
  return pool([
    [/FROM bot_cards a WHERE/, opts.cards || []],
    [/SELECT issue_number FROM homeroom_bot_requesters WHERE user_id = \$1 AND issue_number = ANY/, (opts.requesters || []).map((n) => ({ issue_number: n }))],
    [/SELECT github_issue_number AS n FROM issues/, (opts.closed || []).map((n) => ({ n }))],
    [/SELECT issue_number, created_at FROM feedback_reports/, opts.feedback || []],
    [/SELECT DISTINCT x\.n FROM/, (opts.known || []).map((n) => ({ n }))],
    [/SELECT DISTINCT issue_number AS n FROM feedback_reports\s+WHERE user_id/, (opts.platformReports || []).map((n) => ({ n }))],
    [/FROM apps a JOIN community_members/, opts.projects || []],
    [/FROM apps WHERE id = ANY/, []],
  ]);
}

const kinds = async (p, ctx, text) => (await mayor.claimProblems(p, ctx, text)).map((x) => x.kind);

// Row 1: a start this turn backs "I'll let you know when it's done".
test('#6583 row 1: "I\'ve started on it" with a start this turn keeps its promise', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set(), started: 'Ear Trainer request #14' };
  const out = await kinds(records(), ctx, 'I\'ve started on it. I\'ll let you know when it\'s done.');
  assert.deepEqual(out, []);
});

// Row 2: a request's stored track that is building is started.
test('#6583 row 2: the voice sees a running build of the request as started', async () => {
  const ctx = {
    user: { id: 1 }, app: { id: 9, name: 'Ear Trainer' }, place: { type: 'issue', ref: 14 },
    deps: { track: { tracksForRequests: async () => new Map([[14, { work: { stage: 'building' } }]]) } },
  };
  assert.deepEqual(await kinds(records(), ctx, 'I\'m building it now.'), []);
});

// Row 3: a status is a fact to check; only first-person actions are false.
test('#6583 row 3: a closed or moved status is checked against the request', async () => {
  const closedCtx = { user: { id: 1 }, appIds: new Set() };
  assert.deepEqual(await kinds(records({ closed: [14], known: [14] }), closedCtx, 'Request #14 is closed; its group voted on 3 Nov.'), []);
  const moveCtx = { user: { id: 1 }, appIds: new Set(), conversationId: 5 };
  const moved = await kinds(records({ cards: [{ kind: 'move_request', status: 'done', issue_number: 20 }], known: [20] }),
    moveCtx, 'Request #20 was moved.');
  assert.ok(!moved.includes('moved_status'), moved.join(','));
  // The first person stays false: the bot never closes or moves one.
  const closed = await kinds(records(), closedCtx, 'I closed #14.');
  assert.ok(closed.includes('closed_request'), closed.join(','));
  const movedAction = await kinds(records(), moveCtx, 'I moved it.');
  assert.ok(movedAction.includes('moved'), movedAction.join(','));
});

// Row 4: a project's name is matched against the person's projects.
test('#6583 row 4: a draft\'s or a request\'s project is no unknown name', async () => {
  const p = records({ projects: [
    { name: 'Ear Trainer', slug: 'ear-trainer' },
    { name: 'Rilo', slug: 'rilo' },
    { name: 'Community Tier Lists', slug: 'community-tier-lists' },
  ] });
  const ctx = { user: { id: 1 }, appIds: new Set() };
  for (const text of [
    'Your draft for Ear Trainer is still waiting.',
    'The draft for Dark Mode is ready when you are.',
    'I can file a request for Evan whenever you like.',
    'The request on Rilo I drafted is ready for you.',
  ]) {
    const out = await kinds(p, ctx, text);
    assert.ok(!out.includes('unknown_project'), `${text} -> ${out.join(',')}`);
  }
  // A garble of one of their projects is still caught.
  assert.ok((await kinds(p, ctx, 'The draft for Community Components is ready.')).includes('unknown_project'));
});

// Row 5: an open draft from an earlier turn is a real draft.
test('#6583 row 5: "Tap File it" is backed by an open draft from an earlier turn', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set(), conversationId: 5 };
  const p = records({ cards: [{ kind: 'file_request', status: 'open', issue_number: null }] });
  assert.ok(!(await kinds(p, ctx, 'Tap File it under my last message.')).includes('drafted'));
});

// Row 6: the bot repeating its own platform line is not a fresh claim.
test('#6583 row 6: the bot\'s own earlier filing or plan line backs a repeat', async () => {
  const ctx = {
    user: { id: 1 }, appIds: new Set(),
    earlierBotText: 'Filed it as request #12 on Ear Trainer. I posted version 2 as a plan on request #12.',
  };
  const p = records({ known: [12] });
  assert.ok(!(await kinds(p, ctx, 'Filed it as request #12 on Ear Trainer.')).includes('filed'));
  assert.ok(!(await kinds(p, ctx, 'I posted version 2 as a plan on request #12.')).includes('posted'));
});

// Row 7: a report already on file, including a platform report with no app.
test('#6583 row 7: a report made earlier backs "the team has been told"', async () => {
  const ctx = { user: { id: 1 }, appIds: new Set() };
  const p = records({ feedback: [{ issue_number: 6564, created_at: new Date() }], platformReports: [6564] });
  const out = await mayor.claimProblems(p, ctx, 'The team has been told (#6564).');
  assert.deepEqual(out.map((x) => x.kind), []);
});

// Row 8: an older or just-decided draft is what a typed "File it" means.
test('#6583 row 8: a typed File it under an older draft asks for no note', async () => {
  const older = pool([
    [/FROM bot_cards a JOIN conversation_messages/, []],
    [/FROM bot_cards\s+WHERE user_id = \$1 AND conversation_id = \$2 AND kind = 'file_request'/, [{ id: 1 }]],
  ]);
  const ctx = { bot: { id: 2 }, user: { id: 1 }, settings: {}, conversationId: 5, message: { content: 'File it' } };
  assert.equal(await mayor.decideTyped(older, {}, ctx), null);
  assert.doesNotMatch(mayor.NO_OFFER_NOTE, /nothing has been filed/);
  assert.match(mayor.NO_OFFER_NOTE, /no draft from the last hour is open to decide/);
});

// Row 9: a colour or a ranking is not a request number.
test('#6583 row 9: a colour and a ranking name no request', () => {
  assert.deepEqual(mayor.requestNumbers('Use #222 for the header'), []);
  assert.deepEqual(mayor.requestNumbers('That\'s the #1 priority'), []);
  assert.deepEqual(mayor.requestNumbers('Request #14 is closed'), [14]);
});

// Row 10: the note names only tools the place has, and asks for a lookup.
test('#6583 row 10: a note for the voice names none of the private chat\'s tools', () => {
  const tools = new Set(['reply', 'start_request', 'offer_close_request']);
  const note = mayor.checkNote([{ kind: 'unknown', numbers: [14], said: 'names request #14, which no project of theirs has' }], { tools });
  for (const name of ['comment_on_request', 'revise_proposal', 'withdraw_proposal', 'report_problem']) {
    assert.ok(!note.includes(name), `${name} is not offered in a thread`);
  }
  assert.doesNotMatch(note, /has not been done/);
  // A description this turn changed backs "I've updated it".
  return kinds(records(), { user: { id: 1 }, appIds: new Set(), described: true }, 'I\'ve updated it.')
    .then((out) => assert.ok(!out.includes('revised')));
});

// A platform report filed earlier resolves by number.
test('#6583: a platform report filed in an earlier turn resolves', async () => {
  const p = records({ platformReports: [6564] });
  assert.deepEqual(await mayor.unknownRequests(p, { user: { id: 1 }, appIds: new Set() }, [6564]), []);
});

// The note for an unfound number asks for a lookup, not a retraction.
test('#6583: an unfound number is asked to be looked up', () => {
  const note = mayor.checkNote([{ kind: 'unknown', numbers: [14], said: 'names request #14, which no project of theirs has' }]);
  assert.match(note, /Look the number up with request_detail/);
  assert.doesNotMatch(note, /never name one that does not exist/);
  assert.doesNotMatch(note, /has not been done/);
});

// A failed stored read proves nothing.
test('#6583: a failed stored read keeps the sentence', async () => {
  const broken = { query: async () => { throw new Error('db down'); } };
  const ctx = { user: { id: 1 }, appIds: new Set(), conversationId: 5 };
  assert.deepEqual(await mayor.claimProblems(broken, ctx, 'I\'ve filed it for you.'), []);
  assert.equal(mayor.stripClaims('I\'ve filed it for you.', []), 'I\'ve filed it for you.');
});

// A record-backed claim proven false is cut, with no fixed line.
test('#6583: a proven-false record claim is cut without an "I haven\'t" line', () => {
  const cut = mayor.stripClaims('I\'ve updated the proposal. Here is the rest of the answer, unchanged.',
    [{ kind: 'revised', proof: 'records' }]);
  assert.equal(cut, 'Here is the rest of the answer, unchanged.');
  assert.doesNotMatch(cut, /I haven't/);
});
