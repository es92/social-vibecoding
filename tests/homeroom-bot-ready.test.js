'use strict';

// B7: a change ready to try, and the people who must approve it.
//
// When one of Homeroom bot's changes is ready to try (its preview is up and
// its checks passed or were not needed), whoever asked for it gets a card:
// Try it, Approve when their own Yes counts (cast from their browser, never
// the bot's), and Change something. Whoever else must approve gets one
// `change_ready` notification, on by default and pushed: on a project of
// one person's or a private community, the people active on it; on a public
// community, only the approvers it names (decided: everybody there could
// vote, and nobody is told this way). A Yes cast anywhere settles the card.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-ready.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const dm = require('../src/services/homeroom-bot-dm');

// ── What the card offers, and says ──

test('B7: Try it always, Approve when their Yes counts, Change something; one filled', () => {
  assert.deepEqual(dm.readyActions({ sessionId: 9, epoch: 2, approve: true }), [
    { id: 'try', label: 'Try it', style: 'secondary', type: 'preview', sessionId: 9 },
    { id: 'approve', label: 'Approve', style: 'primary', type: 'vote', sessionId: 9, epoch: 2 },
    { id: 'change', label: 'Change something', style: 'secondary', type: 'reply' },
  ]);
  assert.deepEqual(dm.readyActions({ sessionId: 9, epoch: 2, approve: false }).map((a) => [a.id, a.style]),
    [['try', 'primary'], ['change', 'secondary']], 'with no Approve, Try it is the filled one');
  const ctx = { appName: 'Plant Pal', issueNumber: 2, issueTitle: 'Reminder' };
  assert.equal(dm.dmText('proposal', { sessionId: 9, card: { approve: true, last: true } }, ctx),
    "**Plant Pal** · request #2: Reminder\n\nIt's ready to try. Approve it when you're happy with it, and it goes live.");
  assert.equal(dm.dmText('proposal', { sessionId: 9, card: { approve: true, last: false } }, { ...ctx, group: true }),
    "**Plant Pal** · request #2: Reminder\n\nIt's ready to try. Approve it when you're happy with it.");
  assert.equal(dm.dmText('proposal', { sessionId: 9, card: { approve: false } }, { ...ctx, group: true }),
    "**Plant Pal** · request #2: Reminder\n\nIt's ready to try. It goes live once it's approved.");
  for (const said of ['vote', 'proposal', 'merged']) {
    assert.ok(!new RegExp(said, 'i').test(dm.dmText('proposal', { sessionId: 9, card: { approve: true } }, ctx)), said);
  }
});

test('B7: the card, drawn in every state', () => {
  const { ReadyCardView, readyTitle, waitingLine, isReadyMessage, changeLine, changeLink } = loadTsx('frontend/src/features/messages/bot-ready.tsx');
  const actions = dm.readyActions({ sessionId: 9, epoch: 2, approve: true });
  const meta = {
    kind: 'proposal', appName: 'Plant Pal', appSlug: 'plant-pal', askedText: 'Add a weekly reminder',
    ready: { group: false, last: true, waitingOn: [], more: 0 }, actions, status: 'open', sessionId: 9, epoch: 2,
  };
  const draw = (props) => renderToHtml(createElement(ReadyCardView, { meta, state: 'open', actions, ...props }));
  const open = draw();
  assert.match(open, /data-bot-ready="open"/);
  assert.match(open, />Plant Pal is ready to try</);
  assert.match(open, /You asked: Add a weekly reminder/);
  assert.match(open, /data-bot-ready-action="try"><span>Try it<\/span>/);
  assert.match(open, /class="messages-bot-primary" data-bot-ready-action="approve"><span>Approve<\/span>/);
  assert.match(open, /data-bot-ready-action="change"><span>Change something<\/span>/);
  assert.ok(!/Waiting for approval/.test(open), 'a project of one waits on nobody else');
  // #3870: what the change is, under the title: its own title, else its request's.
  assert.ok(!/data-bot-ready-change/.test(open), 'nothing to say beyond what they asked');
  // #4537: the line names the request and links to the change's page, so
  // Try it is not the only way in.
  const titled = draw({ meta: { ...meta, changeTitle: 'Weekly watering reminder', issueTitle: 'Reminders' } });
  assert.match(titled,
    /data-bot-ready-change=""><a href="#app\/plant-pal\/dev\/proposals\/9" [^>]*data-bot-ready-change-link="">Weekly watering reminder<\/a></,
    'the change line is a link to the change page, on the session the card was sent for');
  assert.ok(titled.indexOf('Weekly watering reminder') < titled.indexOf('You asked:'), 'what it is, then what they asked');
  assert.equal(changeLine({ ...meta, askedText: undefined, issueTitle: 'Reminders' }), 'Reminders');
  assert.equal(changeLine({ ...meta, changeTitle: 'add a weekly reminder.' }), null, 'a title that only repeats what they asked is said once');
  assert.equal(changeLine({ ...meta, askedText: undefined }), null);
  assert.equal(changeLink({ ...meta, sessionId: undefined }, actions), '#app/plant-pal/dev/proposals/9', 'no sent session id: the Try it action\'s');
  assert.equal(changeLink({ ...meta, appSlug: undefined }), null, 'no app slug: the line stays plain text');
  assert.equal(changeLink({ ...meta, sessionId: undefined, actions: [] }), null, 'nothing to open: the Try it action carries it');
  // The card names the request its change answers (#4537).
  const numbered = { ...meta, issueNumber: 2, changeTitle: 'Weekly watering reminder' };
  assert.equal(changeLine(numbered), 'Request #2: Weekly watering reminder');
  assert.equal(changeLine({ ...numbered, changeTitle: 'add a weekly reminder.' }), 'Request #2',
    'a title that only repeats what they asked: the request number still says which change');
  assert.equal(changeLine({ ...numbered, changeTitle: undefined, issueTitle: undefined }), 'Request #2', 'no title of its own, still named');
  const numberedCard = draw({ meta: { ...numbered, askedText: undefined, changeTitle: undefined } });
  assert.match(numberedCard, /data-bot-ready-change-link="">Request #2</);
  assert.equal(changeLine({ ...meta, issueNumber: 2, askedText: undefined, issueTitle: 'Reminders', changeTitle: undefined }), 'Request #2: Reminders');
  // Approved: what happens next, never just "You approved it." (4 October).
  assert.match(draw({ state: 'approved', actions: [] }), />You approved it\. It goes live in a minute or two\.</);
  const stale = draw({ state: 'stale', actions: actions.slice(0, 1) });
  assert.match(stale, /This change was updated\. Try the new version first\./);
  assert.ok(!/Approve</.test(stale), 'a replaced version approves nothing until it is tried');
  assert.match(draw({ state: 'updated', actions: [] }), /This change was updated\. Its newer version is below\./);

  const group = { ...meta, appName: 'Supper Club', ready: { group: true, last: false, waitingOn: ['ada'], more: 0 } };
  assert.equal(readyTitle(group), 'Your change to Supper Club is ready to try');
  assert.equal(waitingLine(group.ready, true), 'Waiting for approval from you and @ada');
  assert.equal(waitingLine(group.ready, false), 'Waiting for approval from @ada');
  assert.equal(waitingLine({ ...group.ready, waitingOn: ['ada', 'cy'], more: 2 }, false), 'Waiting for approval from @ada, @cy and 2 more');
  assert.equal(waitingLine({ ...group.ready, last: true }, true), null, 'their Yes is the last one needed');
  assert.equal(readyTitle({ ...group, firstVersion: true }), 'Supper Club is ready to try');
  // An older card approved before cards said what comes next words it from what it was sent with.
  assert.match(draw({ state: 'approved', actions: [], meta: group }), />You approved it\. It goes live when @ada approves too\.</);
  // The vote's own answer says it at once, and the message's update says it everywhere after.
  const next = { soon: false, at: new Date(2026, 9, 7, 9, 30).toISOString(), missing: 1, waitingOn: ['ada'], more: 0 };
  const sunday = new Date(2026, 9, 4, 18, 0);
  const said = 'You approved it. It goes live when @ada approves too, or on Wednesday if nobody objects.';
  assert.ok(draw({ state: 'approved', actions: [], meta: group, goesLive: next, now: sunday, locale: 'en-US' }).includes(`>${said}<`));
  assert.ok(draw({ state: 'approved', actions: [], meta: { ...group, goesLive: next }, now: sunday, locale: 'en-US' }).includes(`>${said}<`));
  assert.match(draw({ state: 'approved', actions: [], meta: { ...group, goesLive: { soon: true, at: null, missing: 0, waitingOn: [], more: 0 } } }),
    />You approved it\. It goes live in a minute or two\.</, 'the message\'s own word wins over what the card was sent with');

  const msg = (m) => ({ id: 1, sender: { id: 9, username: 'homeroom_bot', bot: true }, content: 'x', metadata: { homeroomBot: m } });
  assert.equal(isReadyMessage(msg(meta)), true);
  assert.equal(isReadyMessage(msg({ ...meta, ready: undefined })), false, 'an older "it is built" keeps its words');
});

test('B7: the client knows the new buttons, and Approve is the person\'s own vote, on the version they were sent', () => {
  const api = read('frontend/src/features/messages/api.ts');
  // #4231: and Invite people, which the client answers itself.
  assert.match(api, /const BOT_ACTION_TYPES = new Set\(\['server', 'open', 'prompt', 'preview', 'vote', 'reply', 'invite'\]\);/);
  assert.match(api, /fetch\(`\/api\/sessions\/\$\{sessionId\}\/vote`, \{/);
  assert.match(api, /body: JSON\.stringify\(epoch === null \? \{ vote: 'yes' \} : \{ vote: 'yes', expectedEpoch: epoch \}\),/);
  assert.match(api, /const stale = response\.status === 409 && pick\(data, 'headChanged'\) === true;/);
  const card = read('frontend/src/features/messages/bot-ready.tsx');
  assert.match(card, /view\.ensureStaging\(sessionId, null, null, \{ readOnly: false, app: \{ slug: meta\.appSlug \} \}\)/);
  // The bot never votes: no server path casts a Yes for the card.
  const dmSrc = read('src/services/homeroom-bot-dm.js');
  assert.ok(!/pr_votes \(|recordVote|\/vote'/.test(dmSrc), 'the bot service writes no vote');
  const votes = read('src/routes/votes.js');
  assert.match(votes, /const goesLive = vote === 'yes'\s*\? await require\('\.\.\/services\/homeroom-bot-dm'\)\.noteApproved\(pool, session\.id, req\.user\.id\)\s*: null;/);
  // Every answer to a recorded Yes carries what happens next, when it settled a card.
  assert.equal((votes.match(/res\.json\(\{ ok: true, merged: false[^}]*\.\.\.readyCard \}\)/g) || []).length, 3);
  const policy = require('../src/services/cli-api-policy');
  assert.equal(policy.isConnectorApiRequest('POST', '/api/sessions/9/vote'), false, 'the vote route stays off the connector list');
  assert.equal(policy.isDelegatedApiRequest('agent_mayor', 'POST', '/api/sessions/9/vote'), false, 'and off the agents\'');
});

// ── What the card says once it is approved ──

test('B7: once approved, the card says what happens next, from the change\'s real gate', () => {
  const governance = require('../src/services/governance');
  const DAY = 24 * 60 * 60 * 1000;
  const opened = Date.parse('2026-10-04T12:00:00Z');
  const now = opened + 60 * 60 * 1000;
  const gate = (gov, active, yes) => governance.computeGate(gov, active, yes, 0, new Date(opened).toISOString(), now);
  const byDefault = { approverPolicy: 'anyone', approvalsRequired: null };

  // Just you: your Yes is all it needs.
  assert.deepEqual(dm.goesLiveAfterYes(gate(byDefault, 1, 1), []), { soon: true });
  // You and one other (Flat 4B Chores, 4 October): one Yes of two, so the
  // lazy-consensus clock runs, three days from when it went up for approval.
  assert.deepEqual(dm.goesLiveAfterYes(gate(byDefault, 2, 1), ['sam_t1004']), {
    soon: false, at: new Date(opened + 3 * DAY).toISOString(), missing: 1, waitingOn: ['sam_t1004'], more: 0,
  });
  // Both said Yes: it goes live now.
  assert.deepEqual(dm.goesLiveAfterYes(gate(byDefault, 2, 2), []), { soon: true });
  // "At least two approvals" runs no clock: it waits for the other Yes.
  assert.deepEqual(dm.goesLiveAfterYes(gate({ approverPolicy: 'anyone', approvalsRequired: 2 }, 5, 1), ['ada', 'ben', 'cy', 'di']), {
    soon: false, at: null, missing: 1, waitingOn: ['ada', 'ben', 'cy'], more: 1,
  });
  // A change to a protected setting is never let through by silence.
  const flagged = governance.computeGate(byDefault, 2, 1, 0, new Date(opened).toISOString(), now, { explicitApproval: true });
  assert.equal(dm.goesLiveAfterYes(flagged, ['sam_t1004']).at, null);
  assert.equal(dm.goesLiveAfterYes(null, []), null);
});

test('B7: the approved line, in words, in the reader\'s own week', () => {
  const { approvedLine, liveDay, goesLiveFromReady } = loadTsx('frontend/src/features/messages/bot-ready.tsx');
  const sunday = new Date(2026, 9, 4, 18, 0);
  const on = (y, m, d, h = 9) => new Date(y, m, d, h, 30).toISOString();
  const line = (next) => approvedLine({ soon: false, at: null, missing: 1, waitingOn: [], more: 0, ...next }, sunday, 'en-US');
  assert.equal(approvedLine({ soon: true, at: null, missing: 0, waitingOn: [], more: 0 }), 'You approved it. It goes live in a minute or two.');
  assert.equal(line({ waitingOn: ['sam_t1004'], at: on(2026, 9, 7) }),
    'You approved it. It goes live when @sam_t1004 approves too, or on Wednesday if nobody objects.');
  assert.equal(line({ waitingOn: ['sam_t1004'] }), 'You approved it. It goes live when @sam_t1004 approves too.');
  assert.equal(line({ missing: 2, waitingOn: ['ada', 'cy'] }), 'You approved it. It goes live when @ada and @cy approve too.');
  assert.equal(line({ missing: 4, waitingOn: ['ada', 'cy', 'di'], more: 1 }), 'You approved it. It goes live when @ada, @cy, @di and 1 more approve too.');
  // Page Turners, 5 October: one Yes of two people's is enough. Both are
  // named, and "or" says either will do; never "when @ada and @cy approve".
  assert.equal(line({ missing: 1, waitingOn: ['ada', 'cy'] }), 'You approved it. It goes live after one more approval from @ada or @cy.',
    'names who can give the one Yes it needs, and that either will do');
  assert.equal(line({ missing: 2, waitingOn: [], at: on(2026, 9, 5) }), 'You approved it. It goes live when 2 more people approve, or tomorrow if nobody objects.');
  assert.equal(line({ missing: 0, at: on(2026, 9, 4, 22) }), 'You approved it. It goes live later today if nobody objects.');
  // The day is a kind and its words; the sentence that holds it is one whole message.
  assert.deepEqual(liveDay(on(2026, 9, 12), sunday, 'en-US'), { kind: 'date', date: 'October 12' }, 'past the week, its date');
  assert.equal(line({ missing: 0, at: on(2026, 9, 12) }), 'You approved it. It goes live on October 12 if nobody objects.');
  assert.deepEqual(liveDay(on(2026, 9, 1), sunday, 'en-US'), { kind: 'date', date: 'October 1' }, 'a day already past, read later');
  assert.equal(line({ missing: 0, at: on(2026, 9, 1) }), 'You approved it. It goes live on October 1 if nobody objects.');
  assert.equal(liveDay('not a date', sunday, 'en-US'), null);
  assert.deepEqual(goesLiveFromReady({ group: false, last: true, waitingOn: [], more: 0 }), { soon: true, at: null, missing: 0, waitingOn: [], more: 0 });
  assert.deepEqual(goesLiveFromReady({ group: true, last: false, waitingOn: ['ada'], more: 2 }), { soon: false, at: null, missing: 3, waitingOn: ['ada'], more: 2 });
  // Plain words: none of the platform's.
  for (const said of [line({ waitingOn: ['ada'], at: on(2026, 9, 7) }), line({ missing: 0 }), approvedLine({ soon: true })]) {
    assert.doesNotMatch(said, /propos|merg|vote|\bPR\b|staging|\u2014/i, said);
  }
});

test('B7: the client reads what happens next from the vote\'s answer and from the card', () => {
  const { normalizeGoesLive, normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  assert.deepEqual(normalizeGoesLive({ soon: true }), { soon: true, at: null, missing: 0, waitingOn: [], more: 0 });
  assert.deepEqual(normalizeGoesLive({ soon: false, at: '2026-10-07T12:00:00.000Z', missing: 1, waitingOn: ['sam', 7, ''], more: 0 }),
    { soon: false, at: '2026-10-07T12:00:00.000Z', missing: 1, waitingOn: ['sam'], more: 0 });
  assert.equal(normalizeGoesLive({ soon: false, at: 'whenever' }).at, null);
  assert.equal(normalizeGoesLive(null), null);
  assert.equal(normalizeGoesLive({ missing: 1 }), null, 'not one of these');
  const meta = normalizeBotMeta({ homeroomBot: { kind: 'proposal', status: 'answered', chosen: 'approve', goesLive: { soon: true } } });
  assert.deepEqual(meta.homeroomBot.goesLive, { soon: true, at: null, missing: 0, waitingOn: [], more: 0 });
  assert.equal('goesLive' in normalizeBotMeta({ homeroomBot: { kind: 'proposal' } }).homeroomBot, false);
  assert.equal(normalizeBotMeta({ homeroomBot: { kind: 'proposal', changeTitle: 'Sunday reminder' } }).homeroomBot.changeTitle, 'Sunday reminder');
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /if \(response\.ok\) return \{ ok: true, stale: false, epoch, error: null, goesLive: normalizeGoesLive\(pick\(data, 'goesLive'\)\) \};/);
  const card = read('frontend/src/features/messages/bot-ready.tsx');
  assert.match(card, /if \(out\.ok\) \{ setGoesLive\(out\.goesLive \|\| null\); setApproved\(true\);/);
  // 5 October: what happens next as read now comes first (readyStates).
  assert.match(card, /const next = fresh\?\.goesLive \|\| meta\.goesLive \|\| goesLive \|\| goesLiveFromReady\(meta\.ready\);/);
});

test('B7: "ready to try" in the bell and on the phone, on by default', async () => {
  const prefs = require('../src/services/notification-preferences');
  assert.equal(prefs.categoryForKind('change_ready'), 'changes_ready');
  assert.equal(prefs.isKindEnabled('change_ready', {}), true);
  const push = require('../src/services/mobile-push-preferences');
  assert.ok(push.ALLOWED_KINDS.has('change_ready'));
  const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
  const copy = buildNotificationCopy('change_ready', { sourceUsername: 'ben', appName: 'Supper Club', sessionTitle: 'Sunday host reminder' });
  // "One story": the change and its project, over who asked and what to do.
  assert.equal(copy.title, 'Sunday host reminder · Supper Club');
  assert.equal(copy.body, "@ben's change is ready to try. Try it and vote.");
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  const row = globalThis.window.Notifications._rowView({
    id: 1, kind: 'change_ready', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Supper Club', appSlug: 'supper-club', sourceUsername: 'ben', sessionTitle: 'Sunday host reminder', sessionId: 5,
  });
  assert.equal(row.label, 'Ready to try');
  assert.equal(row.by, 'ben');
  assert.equal(row.icon, '\u{1F440}');
  assert.match(read('src/services/notifications.js'), /vote_cast: \{ kinds: \['pr_proposed', 'stale_pr', 'revision_recheck', 'change_ready'\]/);
});

// ── Against the full schema ──

test('B7: who approves, who is told, and the card, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_ready_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const governance = require('../src/services/governance');
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const ben = await user('ben');
  const ada = await user('ada');
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');
  const project = async (slug, label, { view = 'private', members = [] } = {}) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $4) RETURNING id`,
      [label, slug, members[0].id, view],
    );
    const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
    for (const m of members) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id],
      );
    }
    governance.invalidateGovernance(app.id);
    return app;
  };
  const active = (app, people) => Promise.all(people.map((p) => pool.query(
    `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)
     ON CONFLICT DO NOTHING`, [app.id, p.id],
  )));
  const change = async (app, requester, issueNumber) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, $3, 'promoted', 'Sunday reminder', NOW(), 'passing') RETURNING id`,
      [app.id, homeroomBot.id, `bot-${app.slug}-${issueNumber}`],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
       VALUES ($1, $2, $3, 'Sunday reminder', 'Remind us on Sundays')`,
      [app.id, issueNumber, requester.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, build_ok)
       VALUES ($1, $2, 'live', 'ready', $3, TRUE)`,
      [app.id, issueNumber, s.id],
    );
    return s.id;
  };
  const card = async (userId, sessionId) => (await pool.query(
    `SELECT m.id, m.content, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
       JOIN homeroom_bot_runs r ON r.id = d.run_id
      WHERE d.user_id = $1 AND d.kind = 'proposal' AND r.proposal_session_id = $2
      ORDER BY m.id DESC LIMIT 1`,
    [userId, sessionId],
  )).rows[0];
  const told = async (sessionId) => (await pool.query(
    `SELECT u.username, n.detail, n.source_user_id FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.session_id = $1 AND n.kind = 'change_ready' ORDER BY u.username`,
    [sessionId],
  )).rows;

  await t.test('just you: her Yes is the last one needed, and nobody else is told', async () => {
    const solo = await project('plant-pal', 'Plant Pal', { members: [maya] });
    const id = await change(solo, maya, 2);
    const state = await dm.approvalState(pool, { sessionId: id, userId: maya.id });
    assert.deepEqual([state.audience, state.counts, state.already, state.last], ['solo', true, false, true]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    const sent = await card(maya.id, id);
    assert.equal(sent.meta.ready.group, false);
    assert.equal(sent.meta.ready.last, true);
    assert.deepEqual(sent.meta.actions.map((a) => a.id), ['try', 'approve', 'change']);
    assert.equal(sent.meta.actions[1].epoch, 0);
    assert.equal(sent.meta.askedText, 'Remind us on Sundays');
    assert.equal(sent.meta.changeTitle, 'Sunday reminder', 'the card says what the change is (#3870)');
    assert.match(sent.content, /It's ready to try\. Approve it when you're happy with it, and it goes live\.$/);
    assert.deepEqual(await told(id), [], 'nobody else must approve');
    // A Yes, from the card or anywhere, settles it on every device, and
    // says what happens next: hers was the last Yes it needed.
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [id, maya.id]);
    assert.deepEqual(await dm.noteApproved(pool, id, maya.id), { soon: true });
    const settled = (await card(maya.id, id)).meta;
    assert.deepEqual([settled.status, settled.chosen, settled.goesLive], ['answered', 'approve', { soon: true }]);
    assert.equal(await dm.noteApproved(pool, id, maya.id), null, 'a second Yes finds no card waiting on it');
  });

  await t.test('a private community: the others active on it are told once per version, and the asker sees who it waits on', async () => {
    const club = await project('supper-club', 'Supper Club', { members: [ben, ada] });
    await active(club, [ben, ada]);
    const id = await change(club, ben, 4);
    const state = await dm.approvalState(pool, { sessionId: id, userId: ben.id });
    assert.deepEqual([state.audience, state.counts, state.last, state.needed], ['invited', true, false, 2]);
    assert.deepEqual(await dm.needsYesFrom(pool, state, { except: [ben.id] }), [ada.id]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    const sent = await card(ben.id, id);
    assert.deepEqual(sent.meta.ready, { group: true, last: false, waitingOn: ['ada'], missing: 2, needed: 2 });
    assert.deepEqual(sent.meta.actions.map((a) => a.id), ['try', 'approve', 'change']);
    assert.deepEqual(await told(id), [{ username: 'ada', detail: 'epoch:0', source_user_id: ben.id }]);
    await dm.noteApproversReady(pool, { sessionId: id, epoch: 0, requesterId: ben.id });
    assert.equal((await told(id)).length, 1, 'once per version');
    await pool.query('UPDATE chat_sessions SET approval_epoch = 1 WHERE id = $1', [id]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    assert.deepEqual((await told(id)).map((r) => r.detail).sort(), ['epoch:0', 'epoch:1'], 'a new version asks again');
    const older = (await pool.query(
      `SELECT m.metadata->'homeroomBot' AS meta FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
        WHERE d.user_id = $1 AND d.kind = 'proposal' ORDER BY m.id`,
      [ben.id],
    )).rows;
    assert.deepEqual([older[0].meta.status, older[0].meta.updated], ['closed', true], 'the older version\'s card gives way');
    // Ben approves the version in front of him: it waits on Ada, or goes
    // live three days after it went up for approval if nobody objects.
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 1)`, [id, ben.id]);
    const { rows: [{ promoted_at: promotedAt }] } = await pool.query('SELECT promoted_at FROM chat_sessions WHERE id = $1', [id]);
    const next = await dm.noteApproved(pool, id, ben.id);
    assert.deepEqual(next, {
      soon: false, at: new Date(new Date(promotedAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      missing: 1, waitingOn: ['ada'], more: 0,
    });
    assert.deepEqual((await card(ben.id, id)).meta.goesLive, next, 'and the card keeps it, on every device');
    await pool.query('DELETE FROM pr_votes WHERE session_id = $1 AND user_id = $2', [id, ben.id]);
    // Ada has said Yes: she is not asked, and nobody is left to ask.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 1)`, [id, ada.id],
    );
    assert.deepEqual(await dm.needsYesFrom(pool, await dm.approvalState(pool, { sessionId: id }), { except: [ben.id] }), []);
  });

  await t.test('a public community tells nobody this way, unless it names its approvers', async () => {
    const town = await project('town-square', 'Town Square', { view: 'public', members: [ben, ada, maya] });
    await active(town, [ben, ada, maya]);
    const id = await change(town, ben, 6);
    const state = await dm.approvalState(pool, { sessionId: id, userId: ben.id });
    assert.equal(state.audience, 'open');
    assert.deepEqual(await dm.needsYesFrom(pool, state, { except: [ben.id] }), []);
    await pool.query(`UPDATE apps SET approver_policy = 'invited' WHERE id = $1`, [town.id]);
    await pool.query(`INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'member')`, [town.id, ada.id]);
    governance.invalidateGovernance(town.id);
    const named = await dm.approvalState(pool, { sessionId: id, userId: ben.id });
    assert.equal(named.counts, false, 'only the named approvers\' Yes counts');
    assert.deepEqual(await dm.needsYesFrom(pool, named, { except: [ben.id] }), [ada.id]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    const sent = await card(ben.id, id);
    assert.deepEqual(sent.meta.actions.map((a) => a.id), ['try', 'change'], 'no Approve for a Yes that does not count');
    assert.match(sent.content, /It goes live once it's approved\.$/);
    assert.deepEqual((await told(id)).map((r) => r.username), ['ada']);
  });
});
