'use strict';

// Run six (14 Oct 2026): "Notify me when it's ready" sat untapped under a
// first version's plan while the tour's last step promised "we'll message you
// when it's live". For a project's first version it is now a switch that
// starts ON, held by the server, plus the bell's avatar for Homeroom bot.
//
// Pinned here:
//   1. The server (src/services/homeroom-bot-dm.js firstVersionNotify,
//      setFirstVersionNotify, sendDm; src/db/schema.sql notify_live), against
//      the full PostgreSQL schema: on from Make it, the maker's own only; on,
//      a first version's ready and live ring and its LIVE is the one owed an
//      email for when no phone can take the push (src/services/activity-mail.js,
//      sent as the bot-dm machine's work); off,
//      both are said in the chat and ring nothing. The routes
//      (src/routes/conversations.js) read and set it for the signed-in maker
//      only, from the page only.
//   2. The switch (frontend/src/features/messages/notify-me.tsx NotifyLive,
//      under the plan: frontend/src/features/messages/bot-plan.tsx
//      notifyFooter): drawn on, "✓ We'll tell you when it's live", a tap
//      turns it off and back on, and the server is told each time.
//   3. The bell (frontend/src/features/notifications/notifications.js,
//      frontend/src/features/notifications/notifications-sheet.tsx): a row
//      from Homeroom bot wears the bot's own face, never a letter tile —
//      except its news about a project, which wears that project's tile
//      (#5877): its picture, else its emoji, else its name's letter.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-notify-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement, FRONTEND } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// ── 1. The server ───────────────────────────────────────────────────────

test('the schema starts every first version told, and says why', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS notify_live BOOLEAN NOT NULL DEFAULT TRUE;/);
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /notify: !!story && !muted,/, 'off, a first version\'s news rings nothing');
});

async function openDatabase(t) {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = `fv_notify_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(read('src/db/schema.sql'));
  return pool;
}

test('a first version\'s maker is told it is live unless they turn it off, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const dm = require('../src/services/homeroom-bot-dm');
  const notifyCopy = require('../src/services/homeroom-bot-notify-copy');

  // What is owed an email: sendDm appends it to the bot-dm machine in the
  // message's own transaction (MailOwed → dm.mail, activity mail's input).
  let seen = 0;
  const owed = async () => (await pool.query(
    `SELECT id, payload FROM wf_events WHERE machine = 'bot-dm' AND type = 'MailOwed' AND id > $1 ORDER BY id`, [seen],
  )).rows.map((r) => ({ ...r.payload.mail, userId: r.payload.userId, messageId: r.payload.messageId, id: Number(r.id) }));
  const forget = async () => { const all = await owed(); if (all.length) seen = all[all.length - 1].id; };

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const ben = await user('ben');
  const project = async (slug, label, owner) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $2, 'running', $3) RETURNING id, slug, name`,
    [label, slug, owner.id],
  )).rows[0];
  const clubVotes = await project('club-votes', 'Club Votes', maya);
  const supper = await project('supper-club', 'Supper Club', ben);

  // Make it: the row is written, and the setup message says what happens now.
  const started = await dm.startFirstVersion(pool, {}, {
    app: clubVotes, user: { ...maya, hasPlatformAccess: true }, brief: 'A club where members vote on the next book we read.',
  });
  assert.ok(started?.conversationId);
  const { rows: [setup] } = await pool.query(
    'SELECT content FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 ORDER BY id DESC LIMIT 1',
    [started.conversationId, bot.id],
  );
  assert.match(setup.content, /I'm setting up Club Votes now\. Once it's ready I'll send you my plan here first, then build its first version and tell you here when it's live\./);
  assert.doesNotMatch(setup.content, /for you to try/);

  // On from Make it, and only its maker's.
  const { rows: [row] } = await pool.query('SELECT notify_live FROM homeroom_bot_first_versions WHERE app_id = $1', [clubVotes.id]);
  assert.equal(row.notify_live, true, 'the default is real, not just drawn');
  assert.equal(await dm.firstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id }), true);
  assert.equal(await dm.firstVersionNotify(pool, { appSlug: 'club-votes', userId: ben.id }), null, 'somebody else\'s');
  assert.equal(await dm.firstVersionNotify(pool, { appSlug: 'supper-club', userId: ben.id }), null, 'a project with no first version');
  assert.equal(await dm.setFirstVersionNotify(pool, { appSlug: 'club-votes', userId: ben.id, on: false }), null, 'nobody else turns it off');
  assert.equal(await dm.setFirstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id, on: 'no' }), null, 'only true or false');
  assert.equal(await dm.firstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id }), true);

  const fv = { appSlug: clubVotes.slug, appName: clubVotes.name, issueNumber: 1, firstVersion: true };
  let n = 0;
  const say = async (to, kind, metadata) => {
    n += 1;
    return dm.sendDm(pool, { bot, userId: to.id, content: `${kind} ${n}`, idempotencyKey: `fv-notify-${n}`, metadata: { kind, ...metadata } });
  };
  const rang = async (messageId) => (await pool.query(
    'SELECT kind, detail FROM notifications WHERE conversation_message_id = $1', [messageId],
  )).rows;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // On: ready rings, with no email (live follows in a minute or two)...
  const ready = await say(maya, 'proposal', fv);
  await flush();
  assert.deepEqual((await rang(ready.messageId)).map((r) => r.kind), ['build_ready']);
  assert.deepEqual(await owed(), [], 'a first version\'s ready sends no email: its live will');
  // ...and live rings, and is the one emailed when no phone can take it.
  const live = await say(maya, 'merged', { ...fv, live: true });
  await flush();
  const liveRows = await rang(live.messageId);
  assert.deepEqual(liveRows.map((r) => r.kind), ['build_live']);
  const emailed = await owed();
  assert.equal(emailed.length, 1);
  assert.equal(emailed[0].userId, maya.id);
  assert.equal(emailed[0].kind, 'build_ready', 'the build mail, worded by its detail');
  assert.equal(emailed[0].messageId, live.messageId);
  assert.equal(emailed[0].detail, liveRows[0].detail);
  assert.deepEqual(notifyCopy.botEmailCopy(emailed[0].detail), {
    subject: 'Club Votes: Your first version is live',
    lead: 'Your first version is live. Open Club Votes to try it.',
  });

  // Anybody else's change is not news in their chat with the bot (5 Nov
  // 2026, docs/plans/bot-one-model.md, step 4): it rings from its stage, and
  // its ready owes its email through the notice clock (work-state-postgres
  // "the bell"), not through a message.
  await forget();
  assert.equal(await say(ben, 'proposal', { appSlug: supper.slug, appName: supper.name, issueNumber: 4 }), null);
  await flush();
  assert.deepEqual(await owed(), [], 'no message, so no mail owed by one');

  // Off: said in the chat, unread, and nothing rings or is emailed.
  assert.equal(await dm.setFirstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id, on: false }), false);
  assert.equal(await dm.firstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id }), false);
  const quietReady = await say(maya, 'proposal', fv);
  const quietLive = await say(maya, 'merged', { ...fv, live: true });
  await flush();
  for (const sent of [quietReady, quietLive]) {
    assert.ok(sent?.messageId, 'still said');
    assert.deepEqual(await rang(sent.messageId), [], 'no bell, and so no push');
  }
  assert.deepEqual(await owed(), [], 'no email');
  const { rows: [stored] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [quietLive.messageId]);
  assert.equal(stored.metadata.homeroomBot.moment, 'live', 'still the live moment in the chat, shown in the main chat too');
  // What is not a first version's ready or live still rings for them.
  const question = await say(maya, 'question', fv);
  assert.deepEqual((await rang(question.messageId)).map((r) => r.kind), ['build_needs_you'], 'a question still needs them');

  // On again: it rings again.
  assert.equal(await dm.setFirstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id, on: true }), true);
  const back = await say(maya, 'merged', { ...fv, live: true });
  await flush();
  assert.deepEqual((await rang(back.messageId)).map((r) => r.kind), ['build_live']);
  assert.equal((await owed()).length, 1);

  await t.test('the routes read and set it for the signed-in maker only, and a write only from the page', async (st) => {
    const express = require('express');
    const { conversationRoutes } = require('../src/routes/conversations');
    const app = express();
    app.use(express.json());
    let actor = maya;
    app.use((req, _res, next) => { req.user = actor; next(); });
    app.use(conversationRoutes({}, { pool }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    st.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = (slug) => `${base}/api/conversations/homeroom-bot/first-versions/${slug}/notify`;
    const get = async (as, slug) => {
      actor = as;
      const res = await fetch(url(slug));
      return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
    };
    const put = async (as, slug, body, site = 'same-origin') => {
      actor = as;
      const res = await fetch(url(slug), {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const mine = await get(maya, 'club-votes');
    assert.deepEqual([mine.status, mine.body], [200, { on: true }]);
    assert.equal(mine.cache, 'private, no-store');
    assert.equal((await get(ben, 'club-votes')).status, 404, 'somebody else\'s: not found');
    assert.equal((await get(maya, 'no-such-project')).status, 404);
    assert.equal((await put(maya, 'club-votes', { on: 'off' })).status, 400, 'only true or false');
    assert.equal((await put(maya, 'club-votes', { on: false }, 'same-site')).status, 403, 'a sibling subdomain cannot switch it');
    assert.equal((await put(ben, 'club-votes', { on: false })).status, 404);
    assert.equal(await dm.firstVersionNotify(pool, { appSlug: 'club-votes', userId: maya.id }), true, 'none of that changed it');
    assert.deepEqual(await put(maya, 'club-votes', { on: false }), { status: 200, body: { on: false } });
    assert.deepEqual((await get(maya, 'club-votes')).body, { on: false });
    assert.deepEqual(await put(maya, 'club-votes', { on: true }), { status: 200, body: { on: true } });
  });
});

// ── 2. The switch ───────────────────────────────────────────────────────

test('the switch, drawn: on with a check and still tappable; off in the accent\'s tint', () => {
  const mod = loadTsx('frontend/src/features/messages/notify-me.tsx');
  assert.equal(message(mod.NOTIFY_LIVE_ON), 'We’ll tell you when it’s live');
  assert.equal(message(mod.NOTIFY_LIVE_OFF), 'Notify me when it’s live');
  const draw = (props) => renderToHtml(createElement(mod.NotifyLiveView, props));
  const on = draw({ on: true });
  assert.match(on, /^<div class="messages-bot-answers" role="group" aria-label="Notifications" aria-live="polite"><button type="button" role="switch" aria-checked="true" class="messages-bot-on" data-bot-notify-live="on"><svg[^>]*>.*?<\/svg><span>We’ll tell you when it’s live<\/span><\/button><\/div>$/);
  assert.doesNotMatch(on, /disabled|aria-pressed/, 'a switch to turn off, not a settled answer; never the accent\'s pressed fill');
  assert.equal(draw({ on: false }),
    '<div class="messages-bot-answers" role="group" aria-label="Notifications" aria-live="polite"><button type="button" role="switch" aria-checked="false" class="messages-bot-tint" data-bot-notify-live="off"><span>Notify me when it’s live</span></button></div>');
  assert.match(draw({ on: true, busy: true }), /data-bot-notify-live="on" disabled=""/, 'saving: it waits');
  assert.match(draw({ on: true, settings: true }), /<\/button><button type="button" class="messages-bot-secondary">Turn on notifications<\/button><\/div>$/,
    'on, but the app\'s notifications are off: the way to turn them on, beside it');
  assert.match(read('public/css/app.css'), /\.messages-bot-answers \.messages-bot-on \{ color: var\(--text-muted\); background: var\(--dc-raised\); \}/,
    'on is settled, so grey as Done is, with no "cursor: default"');
  for (const id of [mod.NOTIFY_LIVE_ON, mod.NOTIFY_LIVE_OFF]) assert.ok(!/—|!/.test(message(id)));
});

// Just enough React to call NotifyLive as a function: state, and effects run
// once when their deps first appear or change.
function hooks() {
  const React = require(require.resolve('react', { paths: [FRONTEND] }));
  const slots = [];
  let i = 0;
  const pending = [];
  const fake = {
    ...React,
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: typeof init === 'function' ? init() : init };
      const slot = slots[k];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || !deps || deps.some((d, j) => d !== prev.deps[j])) {
        slots[k] = { deps };
        pending.push(fn);
      }
    },
  };
  return { React: fake, render(fn) { i = 0; const out = fn(); pending.splice(0).forEach((run) => run()); return out; } };
}

test('the switch: on as the server starts it, read once drawn, and each tap told to the server', async (t) => {
  const h = hooks();
  const mod = loadTsx('frontend/src/features/messages/notify-me.tsx', { stubs: { react: h.React } });
  const calls = [];
  let serverOn = true;
  const saved = [globalThis.fetch, globalThis.window, globalThis.PlatformI18n];
  t.after(() => { [globalThis.fetch, globalThis.window, globalThis.PlatformI18n] = saved; });
  globalThis.window = { location: { search: '' } };
  globalThis.PlatformI18n = englishPlatformI18n();
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, String(url), init.body || null]);
    if (/first-versions/.test(url)) {
      if (method === 'PUT') serverOn = JSON.parse(init.body).on;
      return { ok: true, status: 200, async json() { return { on: serverOn }; } };
    }
    return { ok: true, status: 200, async json() { return { preferences: [{ key: 'builds', enabled: true }] }; } };
  };
  const settle = async () => { for (let k = 0; k < 6; k += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const draw = () => h.render(() => mod.NotifyLive({ appSlug: 'club-votes' }));

  let el = draw();
  assert.equal(el.props.on, true, 'drawn on, before anything is read');
  await settle();
  assert.deepEqual(calls.shift(), ['GET', '/api/conversations/homeroom-bot/first-versions/club-votes/notify', null]);
  el = draw();
  assert.equal(el.props.on, true);

  // Off.
  el.props.onToggle();
  el = draw();
  assert.equal(el.props.on, false, 'at once, while it saves');
  await settle();
  assert.deepEqual(calls.shift(), ['PUT', '/api/conversations/homeroom-bot/first-versions/club-votes/notify', '{"on":false}']);
  assert.deepEqual(calls, [], 'turning it off asks nothing else');
  el = draw();
  assert.deepEqual([el.props.on, el.props.busy], [false, false]);

  // And back on: told to the server, and the tap asks what Notify me asks
  // (in a browser, nothing to ask; "Your builds" read, already on).
  el.props.onToggle();
  await settle();
  assert.deepEqual(calls.map((c) => [c[0], c[1], c[2]]).sort(), [
    ['GET', '/api/me/mobile-push-preferences', null],
    ['PUT', '/api/conversations/homeroom-bot/first-versions/club-votes/notify', '{"on":true}'],
  ]);
  el = draw();
  assert.deepEqual([el.props.on, el.props.busy, el.props.settings], [true, false, false]);
  assert.equal(serverOn, true);

  // A save that fails goes back.
  calls.length = 0;
  globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return { error: 'down' }; } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    el.props.onToggle();
    await settle();
  } finally {
    console.warn = warn;
  }
  el = draw();
  assert.equal(el.props.on, true, 'not saved: still on');

  // Not theirs (the server says not found): nothing is drawn.
  const other = hooks();
  const mod2 = loadTsx('frontend/src/features/messages/notify-me.tsx', { stubs: { react: other.React } });
  globalThis.fetch = async () => ({ ok: false, status: 404, async json() { return { error: 'No such first version' }; } });
  other.render(() => mod2.NotifyLive({ appSlug: 'someone-elses' }));
  await settle();
  assert.equal(other.render(() => mod2.NotifyLive({ appSlug: 'someone-elses' })), null);
});

test('under the plan: a first version gets the switch, whatever this device chose before; a complicated change keeps the offer', () => {
  const plan = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const notify = loadTsx('frontend/src/features/messages/notify-me.tsx');
  const first = plan.notifyFooter({ kind: 'plan', appSlug: 'club-votes', firstVersion: true, plan: { bullets: ['A'], questions: [] } }, false, 7);
  assert.equal(first.props.className, 'mt-3 flex flex-col items-start gap-2');
  const [live, watch] = first.props.children;
  assert.equal(live.type.name, notify.NotifyLive.name);
  assert.deepEqual(live.props, { appSlug: 'club-votes' });
  assert.equal(watch.type.name, 'WatchBuildButton');
  assert.deepEqual(watch.props, { appSlug: 'club-votes' });
  const drawn = renderToHtml(createElement(plan.WatchBuildButton, { appSlug: 'club-votes' }));
  assert.match(drawn, /^<button type="button" data-bot-watch-build="" class="rounded-full bg-zinc-100[^"]*">Watch Homeroom bot build it<\/button>$/,
    'the Hub\'s quiet grey pill, with the Hub\'s words');
  const complicated = { kind: 'plan', appSlug: 'notes', plan: { bullets: ['A'], questions: [], complicated: true } };
  assert.equal(plan.notifyFooter(complicated, true, 7).props.children.type.name, notify.NotifyMe.name);
  assert.equal(plan.notifyFooter(complicated, false, 7), null, 'chosen on this device: not offered again');

  const card = read('frontend/src/features/messages/bot-plan.tsx');
  // Step 3: until then, the line a refused Build it leaves under the buttons.
  assert.match(card, /footer=\{state === 'built' && card && card\.state !== 'done'\s*\? notifyFooter\(meta, offer, userId, conversationId, Number\(message\.id\)\)\s*: state === 'open' && refused \? <OfferRefused refusal=\{refused\} \/> : null\}/,
    'only once built, and only while it is being built');
  assert.match(card, /openAppTab\?\.\(appSlug, 'app'\)/, 'Watch opens the project\'s App tab, as the Hub\'s button does');
  assert.match(card, /messages:bot\.plan\.watch/, 'and says the Hub\'s words');
  assert.equal(message('messages:bot.plan.watch'), 'Watch Homeroom bot build it', 'the Hub\'s own words');
});

test('the API: read and set, and not found is "not theirs"', async (t) => {
  const api = loadTsx('frontend/src/features/messages/api.ts');
  const saved = [globalThis.fetch, globalThis.window];
  t.after(() => { [globalThis.fetch, globalThis.window] = saved; });
  globalThis.window = { location: { search: '' } };
  const seen = [];
  let answer = { status: 200, body: { on: false } };
  globalThis.fetch = async (url, init = {}) => {
    seen.push([init.method || 'GET', url, init.body || null]);
    return { ok: answer.status < 400, status: answer.status, async json() { return answer.body; } };
  };
  assert.equal(await api.getFirstVersionNotify('club votes'), false);
  assert.deepEqual(seen.at(-1), ['GET', '/api/conversations/homeroom-bot/first-versions/club%20votes/notify', null]);
  answer = { status: 200, body: { on: true } };
  assert.equal(await api.setFirstVersionNotify('club-votes', true), true);
  assert.deepEqual(seen.at(-1), ['PUT', '/api/conversations/homeroom-bot/first-versions/club-votes/notify', '{"on":true}']);
  answer = { status: 404, body: { error: 'No such first version' } };
  assert.equal(await api.getFirstVersionNotify('club-votes'), null);
  answer = { status: 500, body: { error: 'down' } };
  await assert.rejects(() => api.getFirstVersionNotify('club-votes'));
});

// ── 3. The bell ─────────────────────────────────────────────────────────

test('a notification from Homeroom bot wears the bot\'s own face, or its project\'s tile, never a letter tile of its handle', (t) => {
  const saved = [globalThis.window, globalThis.addEventListener, globalThis.removeEventListener];
  t.after(() => { [globalThis.window, globalThis.addEventListener, globalThis.removeEventListener] = saved; });
  globalThis.window = globalThis;
  // The sheet's modules listen on the window as they load.
  globalThis.addEventListener = globalThis.addEventListener || (() => {});
  globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  const N = globalThis.window.Notifications;
  const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
  const AT = new Date(Date.now() - 60 * 1000).toISOString();
  const detail = notifyCopy.botNotificationDetail({ moment: 'live', said: 'live_first', appName: 'Club Votes', firstVersion: true });
  const live = N._rowView({
    id: 1, createdAt: AT, readAt: null, kind: 'build_live', detail, conversationId: 7,
    conversationKind: 'direct', sourceUsername: 'homeroom_bot', messageContent: 'Your first version is live.',
  });
  assert.equal(live.label, 'Live');
  assert.equal(live.bot, true);
  // A build row with no detail is still the bot's; so is its account's message.
  assert.equal(N._rowView({ id: 2, createdAt: AT, kind: 'build_stopped', detail: null, conversationId: 7, conversationKind: 'direct' }).bot, true);
  assert.equal(N._rowView({ id: 3, createdAt: AT, kind: 'conversation_message', detail: null, conversationId: 7, conversationKind: 'direct', sourceUsername: 'homeroom_bot', messageContent: 'hi' }).bot, true);
  const person = N._rowView({ id: 4, createdAt: AT, kind: 'conversation_message', detail: null, conversationId: 7, conversationKind: 'direct', sourceUsername: 'hana', messageContent: 'hi' });
  assert.equal(person.bot, undefined, 'a person keeps their own tile');

  const sheet = loadTsx('frontend/src/features/notifications/notifications-sheet.tsx');
  const face = renderToHtml(createElement(sheet.AvatarChip, { view: live }));
  // (React's server render puts a preload link for the image before it.)
  assert.match(face, /<img src="\/brand\/homeroom-mark\.png" alt="" class="w-11 h-11 text-sm rounded-xl object-cover shrink-0" data-bot-avatar=""\/>$/,
    'the Homeroom mark, the same tile Messages draws for the bot, at the row\'s 44px');
  const tile = renderToHtml(createElement(sheet.AvatarChip, { view: person }));
  assert.match(tile, /^<span aria-hidden="true" class="w-11 h-11 shrink-0 rounded-xl text-white flex items-center justify-center text-sm font-semibold" style="background-color:[^"]+">H<\/span>$/);
  assert.doesNotMatch(face, /background-color|>H</, 'not the orange "H"');

  // #5877: the bot's news about a project wears that project's tile, so a
  // list of "Ready to try" rows names its projects at a glance. The same
  // picture, emoji, letter order every app surface draws.
  const aboutApp = (extra) => N._rowView({
    id: 5, createdAt: AT, readAt: null, kind: 'build_ready',
    detail: notifyCopy.botNotificationDetail({ moment: 'ready', said: 'ready', appName: 'Plant shelf', requestTitle: 'Water reminders' }),
    conversationId: 7, conversationKind: 'direct', sourceUsername: 'homeroom_bot',
    messageContent: 'Ready to try', appId: 42, appName: 'Plant shelf', appSlug: 'plant-shelf', ...extra,
  });
  const withPicture = aboutApp({ appIconUrl: '/app-icons/42', appIconEmoji: '🌱' });
  assert.equal(withPicture.appIconUrl, '/app-icons/42');
  assert.equal(withPicture.appIconEmoji, '🌱', 'the project rides the row with the bot');
  const projectFace = renderToHtml(createElement(sheet.AvatarChip, { view: withPicture }));
  assert.match(projectFace, /data-icon="image" class="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"/,
    'the same 44px tile Discover and My apps draw, in the row\'s own box');
  assert.match(projectFace, /<img src="\/app-icons\/42" alt=""/, 'the project\'s picture');
  assert.doesNotMatch(projectFace, /data-bot-avatar|homeroom-mark/, 'not the Homeroom mark');
  // Emoji only: the tile holds it; no picture.
  const emojiFace = renderToHtml(createElement(sheet.AvatarChip, { view: aboutApp({ appIconEmoji: '🌱' }) }));
  assert.match(emojiFace, /data-icon="emoji"/);
  assert.match(emojiFace, /<span class="text-3xl leading-none" aria-hidden="true">🌱<\/span>/);
  assert.doesNotMatch(emojiFace, /data-bot-avatar|<img /);
  // Neither: the name's letter, on the plain tile every other project screen draws.
  const letterFace = renderToHtml(createElement(sheet.AvatarChip, { view: aboutApp({}) }));
  assert.match(letterFace, /^<span aria-hidden="true" data-icon="letter" class="app-icon-tile[^"]*">P<\/span>$/);
  assert.doesNotMatch(letterFace, /data-bot-avatar/);
  // A person's row is unchanged even when its serialize names an app (the
  // fail-closed rule): it keeps its swatch tile.
  const personWithApp = renderToHtml(createElement(sheet.AvatarChip, {
    view: { ...person, appId: 42, appName: 'Plant shelf', appIconUrl: '/app-icons/42' },
  }));
  assert.match(personWithApp, /background-color/, 'a person keeps the swatch');
});
