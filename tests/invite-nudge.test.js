'use strict';

// The bring-a-friend nudge (src/services/invite-nudge.js): what Homeroom bot
// says to somebody new to a project after their first act there, its two
// buttons, who the sweep asks for, how its Not now is decided, and the clock
// that runs it. The queries themselves run against the real schema in
// tests/invite-nudge-postgres.test.js.
//
// Run with: node --test tests/invite-nudge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dm = require('../src/services/homeroom-bot-dm');
const nudges = require('../src/services/invite-nudge');
const mayor = require('../src/services/homeroom-bot-mayor');
const conversations = require('../src/services/conversations');
const usernames = require('../src/services/usernames');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the message names what they did first, and the project, twice', () => {
  const said = (act, appName = 'Run Club') => dm.inviteNudgeText({ act, appName });
  const tail = '\n\nThey can use it straight away and help shape it.';
  assert.equal(said('vote'), `You voted in Run Club. Run Club is better with your people: invite one or two friends?${tail}`);
  assert.equal(said('message'), `You posted in Run Club. Run Club is better with your people: invite one or two friends?${tail}`);
  assert.equal(said('request'), `You asked for a change in Run Club. Run Club is better with your people: invite one or two friends?${tail}`);
  assert.equal(said('change'), `You made a change in Run Club. Run Club is better with your people: invite one or two friends?${tail}`);
  assert.equal(said('app'), `You used the app in Run Club. Run Club is better with your people: invite one or two friends?${tail}`);
  assert.deepEqual(Object.keys(dm.INVITE_NUDGE_ACTS).sort(), ['app', 'change', 'message', 'request', 'vote']);
  // Nothing to say for an act it has no words for, or no project.
  assert.equal(said('feedback'), null);
  assert.equal(said('vote', '  '), null);
  // One line of a name, however it was typed.
  assert.match(said('vote', 'Run\n  Club'), /^You voted in Run Club\. Run Club is better/);
  for (const act of Object.keys(dm.INVITE_NUDGE_ACTS)) assert.doesNotMatch(said(act), /—|–/);
});

test('its buttons: the go-live Invite people, the act, and Not now, decided on the server', () => {
  const [invite, notNow] = dm.inviteNudgeActions();
  // The same button a first version's live offers (bot-question.tsx opens the invite sheet in place).
  const live = dm.firstLiveActions({ slug: 'run-club' }).find((a) => a.type === 'invite');
  assert.deepEqual({ ...live, style: 'primary' }, invite);
  assert.deepEqual(invite, { id: 'invite_people', label: 'Invite people', type: 'invite', style: 'primary' });
  assert.deepEqual(notNow, { id: 'no', label: 'Not now', style: 'secondary', type: 'server' });
  assert.equal(notNow.label, mayor.NOT_NOW, 'the words every other Not now says');
  const meta = dm.inviteNudgeMeta({ slug: 'run-club', appName: 'Run Club', act: 'vote', actionId: '41' });
  assert.deepEqual(meta, {
    kind: 'invite_friends', appSlug: 'run-club', appName: 'Run Club', act: 'vote', actionId: 41,
    actions: [invite, notNow], status: 'open', mirrors: false,
  });
  // It rings nothing, and it is not a request's news (which Main Chat leaves out).
  assert.equal(dm.momentOf(meta), null);
  assert.equal(conversations.isRequestNewsMeta(meta), false);
  // The client draws both kinds of button, and opens the invite sheet from the message's project.
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /const BOT_ACTION_TYPES = new Set\(\[[^\]]*'server'[^\]]*'invite'[^\]]*\]\);/);
  const question = read('frontend/src/features/messages/bot-question.tsx');
  assert.match(question, /if \(action\.type === 'invite'\) \{\s+if \(invite\) setInviting\(true\);/);
  assert.match(question, /const slug = meta\.appSlug \|\| '';/);
});

test('who the sweep asks for: its windows, its exclusions and one target a person', async () => {
  assert.equal(nudges.JOINED_WITHIN_DAYS, 14);
  assert.equal(nudges.ACTED_WITHIN_HOURS, 48);
  assert.equal(nudges.ONE_A_WEEK_DAYS, 7);
  const asked = [];
  const pool = { async query(sql, params) { asked.push({ sql, params }); return { rows: [
    { user_id: 7, app_id: 3, act: 'vote', acted_at: '2026-11-09T10:00:00Z' },
    { user_id: 9, app_id: 4, act: 'app', acted_at: '2026-11-09T08:00:00Z' },
  ] }; } };
  const now = new Date('2026-11-09T12:00:00Z');
  const out = await nudges.targets(pool, { now, limit: 50 });
  assert.deepEqual(out, {
    owed: 2,
    items: [
      { target: 'invite-nudge:7', input: { userId: 7, appId: 3 } },
      { target: 'invite-nudge:9', input: { userId: 9, appId: 4 } },
    ],
  });
  assert.equal(asked[0].sql, nudges.DUE_SQL);
  const [at, days, hours, services, week, userId, appId, limit] = asked[0].params;
  assert.deepEqual([at, days, hours, week, userId, appId, limit], [now, 14, 48, 7, null, null, 50]);
  assert.deepEqual(services.sort(), [...usernames.SERVICE_IDENTITIES].map((n) => n.toLowerCase()).sort());
  const sql = nudges.DUE_SQL;
  // The window: a recent membership, or a private member's recent redemption.
  assert.match(sql, /cm\.joined_at > \$1::timestamptz - make_interval\(days => \$2::int\)/);
  assert.match(sql, /x\.status = 'joined' AND ru\.private_member_since IS NOT NULL\s+AND x\.applied_at > \$1::timestamptz - make_interval\(days => \$2::int\)/);
  assert.match(sql, /AND fa\.at > \$1::timestamptz - make_interval\(hours => \$3::int\)/);
  // Never the maker, a test, synthetic or service account, or somebody the bot does not work for.
  assert.match(sql, /cm\.source <> 'creator' AND a\.created_by IS DISTINCT FROM u\.id/);
  assert.match(sql, /u\.is_synthetic IS NOT TRUE AND u\.test_account_created_at IS NULL/);
  assert.match(sql, /NOT \(LOWER\(u\.username\) = ANY\(\$4::text\[\]\)\)/);
  assert.match(sql, /\(u\.has_platform_access OR u\.is_admin OR u\.private_member_since IS NOT NULL\)/);
  assert.match(sql, /a\.status = 'running' AND a\.self_hosted IS NOT TRUE/);
  // Once a project, one a week.
  assert.match(sql, /SELECT 1 FROM invite_nudges n\s+WHERE n\.user_id = u\.id\s+AND \(n\.app_id = a\.id OR n\.created_at > \$1::timestamptz - make_interval\(days => \$5::int\)\)/);
  assert.match(sql, /SELECT DISTINCT ON \(u\.id\)[\s\S]*ORDER BY u\.id, fa\.at DESC, a\.id/);
  // The act sources are the Journey's (journey.js PERSON_JOINS), narrowed to the project.
  const journey = read('src/services/journey.js');
  for (const source of ['FROM chat_messages cmx', 'FROM pr_votes pv', 'FROM issue_votes iv', 'FROM issues i WHERE i.created_by',
    'FROM chat_sessions cs WHERE cs.user_id', 'FROM app_activity aa WHERE aa.user_id']) {
    assert.ok(journey.includes(source), `journey reads ${source}`);
    assert.ok(nudges.FIRST_ACT_SQL.includes(source), `the nudge reads ${source}`);
  }
  assert.match(nudges.FIRST_ACT_SQL, /cmx\.app_id = a\.id AND cmx\.msg_type = 'message' AND cmx\.deleted_at IS NULL/);
});

test('switched off, it asks for nothing and sends nothing', async (t) => {
  const was = process.env.INVITE_NUDGE;
  t.after(() => { if (was === undefined) delete process.env.INVITE_NUDGE; else process.env.INVITE_NUDGE = was; });
  assert.equal(nudges.enabled({}), true);
  assert.equal(nudges.enabled({ INVITE_NUDGE: 'off' }), false);
  process.env.INVITE_NUDGE = 'off';
  const pool = { query() { throw new Error('nothing is read'); } };
  assert.deepEqual(await nudges.targets(pool), { off: true });
  const steps = { once: () => { throw new Error('no step'); } };
  assert.deepEqual(await nudges.nudge(pool, { userId: 1, appId: 2 }, steps), { skipped: 'off' });
  delete process.env.INVITE_NUDGE;
  assert.deepEqual(await nudges.nudge(pool, { userId: 'x', appId: 2 }, steps), { skipped: 'bad_target' });
});

test('the item claims, then sends, each a step', async () => {
  const done = [];
  const steps = { async once(key, fn) { done.push(key); return key === 'claim' ? { skipped: 'not_due' } : fn(); } };
  assert.deepEqual(await nudges.nudge({}, { userId: 1, appId: 2 }, steps), { skipped: 'not_due' });
  assert.deepEqual(done, ['claim'], 'nothing is sent for a claim that found nothing');
  const src = read('src/services/invite-nudge.js');
  assert.match(src, /const claimed = await steps\.once\('claim', \(\) => claim\(pool, \{ userId, appId, deps \}\)\);\s+if \(!claimed\?\.nudgeId\) return claimed;\s+return steps\.once\('sent', \(\) => send\(pool, claimed, deps\)\);/);
  // The claim: a lock on the person, the question asked again, the card and the row in one transaction.
  assert.match(src, /pg_advisory_xact_lock\(\$1, \$2\)', \[INVITE_NUDGE_LOCK, Number\(userId\)\]/);
  assert.match(src, /ON CONFLICT \(user_id, app_id\) DO NOTHING RETURNING id/);
  // The send: Main, under the row's idempotency key.
  assert.match(src, /idempotencyKey: `hrbot-invite-nudge-\$\{claimed\.nudgeId\}`/);
  assert.match(src, /threadRootId: false,/);
  assert.equal(require('../src/services/advisory-locks').INVITE_NUDGE_LOCK, 991031);
});

test('a send the chat refuses settles its card as failed', async () => {
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; } };
  const fakeDm = { ...dm, async botAccount() { return { id: 1 }; }, async sendDm() { return null; } };
  const out = await nudges.send(pool, { nudgeId: 5, cardId: 6, userId: 7, appId: 8, act: 'vote', slug: 'run-club', name: 'Run Club' }, { dm: fakeDm });
  assert.deepEqual(out, { said: 'not_sent' });
  assert.match(queries[0].sql, /UPDATE bot_cards SET status = 'failed', error = 'not_sent' WHERE id = \$1 AND status = 'open'/);
  assert.deepEqual(queries[0].params, [6]);
  await assert.rejects(nudges.send(pool, { nudgeId: 5 }, { dm: { ...fakeDm, async botAccount() { return null; } } }), /not available/);
});

test('Not now is decided once on the server, and only Not now', async () => {
  const card = { id: 41, user_id: 7, kind: 'invite_friends', status: 'open', message_id: 90, conversation_id: 12, place: 'dm' };
  const pool = { async query() { return { rows: [card] }; } };
  const dismissed = [];
  const deps = { inviteNudge: { async dismiss(_pool, args) { dismissed.push(args); return { ok: true, choice: 'no', label: 'Not now' }; } } };
  assert.deepEqual(await mayor.decideOfferTap(pool, {}, { user: { id: 7 }, actionId: 41, choice: 'yes', deps }),
    { ok: false, status: 400, error: 'choice must be no' });
  assert.deepEqual(await mayor.decideOfferTap(pool, {}, { user: { id: 7 }, actionId: 41, choice: 'build', deps }),
    { ok: false, status: 400, error: 'choice must be no' });
  assert.deepEqual(await mayor.decideOfferTap(pool, {}, { user: { id: 7 }, actionId: 41, choice: 'no', deps }),
    { ok: true, choice: 'no', label: 'Not now' });
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].action, card);
  // Its dismissal: the card declined if still open, the row's dismissed_at, the buttons answered.
  const queries = [];
  const states = [];
  const answer = (rows) => ({ async query(sql, params) { queries.push({ sql, params }); return { rows: /UPDATE bot_cards/.test(sql) ? rows : [] }; } });
  const fakeDm = { ...dm, async setQuestionState(_p, id, patch) { states.push({ id, patch }); } };
  assert.deepEqual(await nudges.dismiss(answer([{ id: 41 }]), { user: { id: 7 }, action: card, deps: { dm: fakeDm } }),
    { ok: true, choice: 'no', label: 'Not now' });
  assert.match(queries[0].sql, /UPDATE bot_cards SET status = 'declined'[\s\S]*WHERE id = \$1 AND user_id = \$2 AND status = 'open'/);
  assert.match(queries[1].sql, /UPDATE invite_nudges SET dismissed_at = COALESCE\(dismissed_at, NOW\(\)\) WHERE card_id = \$1/);
  assert.deepEqual(states, [{ id: 90, patch: { status: 'answered', answer: 'Not now', chosen: 'no' } }]);
  assert.deepEqual(await nudges.dismiss(answer([]), { user: { id: 7 }, action: card, deps: { dm: fakeDm } }),
    { ok: false, status: 409, error: 'already_decided' });
  // Words typed or quoted never decide it: the model reads them.
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /AND a\.kind NOT IN \('build_plan', 'invite_friends'\)/);
  assert.match(src, /if \(!action \|\| action\.kind === 'build_plan' \|\| action\.kind === INVITE_NUDGE_KIND\) return null;/);
  assert.equal(mayor.OFFER_ANSWERS.invite_friends, undefined, 'no offer words of its own');
});

test('the invite-nudge clock: a run every ten minutes, and one item per person', () => {
  const clock = read('src/workflow/clock/services.ts');
  assert.match(clock, /name: 'invite-nudge', everyMs: 10 \* MIN,\s+run: \(_ctx: WorkContext, \{ pool \}: JobDeps\) => legacy\('services\/invite-nudge'\)\.targets\(pool, \{ limit: MAX_ITEMS \}\),\s+item: \{\s+concurrency: 2,\s+maxAttempts: 3,\s+run: \(ctx: WorkContext, \{ pool \}: JobDeps\) => legacy\('services\/invite-nudge'\)\.nudge\(pool, ctx\.input\.input, ctx\.steps\(\)\),/);
  // The card kind is allowed in the store, and the marker is once a project.
  const migration = read('src/db/migrations/invite-nudges.sql');
  assert.match(migration, /UNIQUE \(user_id, app_id\)/);
  assert.match(migration, /'overlap',\s+'run_shots', 'post_pictures_plan', 'invite_friends'\)\);/,
    'invite_friends added to the list before it (change-pictures\' run_shots and post_pictures_plan kept)');
  assert.match(migration, /COMMENT ON TABLE invite_nudges IS 'staging:private';/);
  const manifest = JSON.parse(read('src/db/migrations/manifest.json'));
  assert.ok(JSON.stringify(manifest).includes('"invite-nudges"'));
});
