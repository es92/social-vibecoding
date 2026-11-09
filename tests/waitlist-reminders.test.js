'use strict';

// The reminders to people let in from the waitlist who have not signed in
// (src/services/waitlist-reminders.js): their spacing and who is owed one,
// the claim that keeps each to once, the stop link, the last one's Reply-To
// through every transport, their copy, and the template version a send
// records. The eligibility SQL against the real schema is
// tests/waitlist-reminders-postgres.test.js.
//
// Run with: node --test tests/waitlist-reminders.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const reminders = require('../src/services/waitlist-reminders');
const rateLimit = require('../src/services/mail/rate-limit');
const events = require('../src/services/mail/events');
const tracking = require('../src/services/mail/tracking');
const { buildMessage } = require('../src/services/mail/templates');
const { ACTIONS, admittedDay, dayMonth, replyAddress } = require('../src/services/mail/actions');
const { englishTemplate } = require('../src/db/email-template-seeds');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONFIG = { sessionSecret: 'test-only-secret', mailReplyTo: 'support@usernodelabs.org' };

// ── Spacing and who ─────────────────────────────────────────────────────

test('two reminders: the first 2 days after the admit, the last 6 after it and 4 after the first', () => {
  assert.equal(reminders.FIRST_AFTER_DAYS, 2);
  assert.equal(reminders.LAST_AFTER_DAYS, 6);
  assert.equal(reminders.LAST_GAP_DAYS, 4);
  assert.match(reminders.FIRST_DUE_SQL, /w\.reminder_1_sent_at IS NULL/);
  assert.match(reminders.FIRST_DUE_SQL, new RegExp(`w\\.released_at <= NOW\\(\\) - INTERVAL '${reminders.FIRST_AFTER_DAYS} days'`));
  assert.match(reminders.LAST_DUE_SQL, /w\.reminder_1_sent_at IS NOT NULL AND w\.reminder_2_sent_at IS NULL/);
  assert.match(reminders.LAST_DUE_SQL, new RegExp(`w\\.released_at <= NOW\\(\\) - INTERVAL '${reminders.LAST_AFTER_DAYS} days'`));
  assert.match(reminders.LAST_DUE_SQL, new RegExp(`w\\.reminder_1_sent_at <= NOW\\(\\) - INTERVAL '${reminders.LAST_GAP_DAYS} days'`));
  assert.deepEqual(reminders.KINDS, { 1: 'waitlist_reminder', 2: 'waitlist_reminder_last' });
  // Nothing is owed once the second went: the last's due test needs it unset.
  assert.match(reminders.OWED_SQL, /\(\(w\.reminder_1_sent_at IS NULL[\s\S]*OR \(w\.reminder_1_sent_at IS NOT NULL AND w\.reminder_2_sent_at IS NULL/);
});

test('owed: admitted with an address, not a test release, not stopped, not suppressed, and not signed in since', () => {
  const sql = reminders.OWED_SQL;
  assert.match(sql, /w\.released_at IS NOT NULL/);
  assert.match(sql, /w\.email IS NOT NULL/, 'a phone-only row gets none');
  assert.match(sql, /w\.reminders_stopped_at IS NULL/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM test_waitlist_releases t WHERE t\.signup_id = w\.id\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM mail_suppressions ms WHERE ms\.recipient = lower\(w\.email\)\)/);
  assert.match(sql, /AND NOT \(w\.release_link_followed_at IS NOT NULL/);
  assert.match(reminders.SIGNED_IN_SQL, /w\.release_code_asked_at IS NOT NULL/);
  assert.match(reminders.SIGNED_IN_SQL, /d\.kind = 'otp' AND d\.created_at >= w\.released_at/);
  assert.match(reminders.SIGNED_IN_SQL, /s\.created_at > w\.released_at OR s\.last_seen_at > w\.released_at/);
  // No age limit: nothing bounds how long ago the admit was.
  assert.doesNotMatch(sql, /released_at >=? NOW\(\)/);
  assert.match(sql, /ORDER BY w\.released_at, w\.id\s+LIMIT \$1/);
});

test('each claim is a compare-and-set on its own stamp, with every rule checked again', () => {
  for (const [sql, column] of [[reminders.CLAIM_FIRST_SQL, 'reminder_1_sent_at'], [reminders.CLAIM_LAST_SQL, 'reminder_2_sent_at']]) {
    assert.match(sql, new RegExp(`SET ${column} = NOW\\(\\)`));
    assert.match(sql, new RegExp(`AND w\\.${column} IS NULL`));
    assert.ok(sql.includes(reminders.REACHABLE_SQL), 'reachable');
    assert.ok(sql.includes(`NOT ${reminders.SIGNED_IN_SQL}`), 'not signed in');
    assert.match(sql, /\(\$2::boolean OR /, 'the spacing, unless an admin asked');
  }
  assert.match(reminders.CLAIM_LAST_SQL, /AND w\.reminder_1_sent_at IS NOT NULL/, 'the last only after the first');
});

test('the clock sends fewer an hour than the reminders\' own budget, which sign-in codes do not share', () => {
  const runsPerHour = (60 * 60 * 1000) / reminders.EVERY_MS;
  assert.ok(reminders.PER_RUN * runsPerHour < rateLimit.REMINDER_MAX_PER_HOUR);
  for (const kind of Object.values(reminders.KINDS)) {
    assert.ok(rateLimit.RULES[kind], `${kind} has a per-recipient rule`);
    assert.equal(rateLimit.budgetOf(kind).maxPerHour, rateLimit.REMINDER_MAX_PER_HOUR);
    assert.ok(rateLimit.OWN_BUDGET_KINDS.includes(kind));
    assert.ok(events.isTracked(kind), `${kind} is tracked like the admit mail`);
  }
  assert.equal(rateLimit.budgetOf('otp'), null, 'sign-in codes keep the global budget');
  // One a day per address, whoever sends it.
  const rule = rateLimit.RULES.waitlist_reminder;
  const now = Date.now();
  const again = rateLimit.decide({ kind: 'waitlist_reminder', now, recipientHistory: [{ status: 'sent', created_at: new Date(now - 60 * 60 * 1000) }] });
  assert.equal(again.allowed, false);
  assert.equal(rule.perWindow, 1);
  const services = read('src/workflow/clock/services.ts');
  assert.match(services, /name: 'waitlist-reminders', everyMs: 10 \* MIN,/);
  assert.equal(reminders.EVERY_MS, 10 * 60 * 1000);
});

test('the clock sends only when the Reminders setting is On; Dry run, the default, counts and sends none', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(sql);
      if (/FROM platform_settings s/.test(sql)) return { rows: [{ value: 'off' }] };
      throw new Error(`unexpected: ${sql}`);
    },
  };
  assert.deepEqual(await reminders.owedTargets(CONFIG, pool), { off: 'switched_off', items: [] });
  assert.deepEqual(await reminders.owedTargets({}, pool), { off: 'no_secret', items: [] });
  // No row is Dry run: it counts who is owed one and lists none to send.
  for (const rows of [[], [{ value: 'dry_run' }], [{ value: 'true' }]]) {
    const dry = {
      async query(sql) {
        if (/FROM platform_settings s/.test(sql)) return { rows };
        if (sql === reminders.DUE_COUNT_SQL) return { rows: [{ first: 3, last: 2 }] };
        throw new Error(`unexpected: ${sql}`);
      },
    };
    assert.deepEqual(await reminders.owedTargets(CONFIG, dry), { off: 'dry_run', owed: 5, items: [] }, JSON.stringify(rows));
  }
  const on = {
    async query(sql, params) {
      if (/FROM platform_settings s/.test(sql)) return { rows: [{ value: 'on' }] };
      if (sql === reminders.OWED_SQL) {
        assert.deepEqual(params, [reminders.PER_RUN]);
        return { rows: [{ id: '4', reminder: 1 }, { id: '9', reminder: 2 }] };
      }
      throw new Error(`unexpected: ${sql}`);
    },
  };
  const listed = await reminders.owedTargets(CONFIG, on);
  assert.deepEqual(listed.items, [
    { target: 'waitlist-reminder:4:1', input: { signupId: 4, reminder: 1 } },
    { target: 'waitlist-reminder:9:2', input: { signupId: 9, reminder: 2 } },
  ]);
});

// ── Claim, send, give back ──────────────────────────────────────────────

// A pool standing in for one waitlist row, answering what a reminder reads
// and writes; `deliveryStatus` is what the mailer recorded for the send.
function rowPool({ row, claimable = true, deliveryStatus = 'sent', deliveryError = null, switchedOff = false, readFails = false } = {}) {
  const state = { claims: 0, unclaims: [], links: 0, row: { ...row } };
  const pool = {
    state,
    async query(sql, params) {
      if (/FROM platform_settings s/.test(sql)) return { rows: [{ value: switchedOff ? 'off' : 'on' }] };
      if (sql === reminders.CLAIM_FIRST_SQL || sql === reminders.CLAIM_LAST_SQL) {
        state.claims += 1;
        if (!claimable || state.claims > 1) return { rows: [] };
        return { rows: [{ ...state.row, claimed_at: '2026-11-09 09:00:00.123456+00' }] };
      }
      if (/^\s*UPDATE waitlist_signups\s+SET reminder_[12]_sent_at = NULL/.test(sql)) {
        state.unclaims.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (/DELETE FROM waitlist_release_links/.test(sql)) return { rowCount: 0, rows: [] };
      if (/INSERT INTO waitlist_release_links/.test(sql)) { state.links += 1; return { rowCount: 1, rows: [] }; }
      if (/SELECT clock_timestamp\(\) AS at/.test(sql)) return { rows: [{ at: new Date() }] };
      if (/FROM mail_deliveries\s+WHERE recipient = \$1 AND kind = \$2/.test(sql)) {
        if (readFails) throw new Error('connection reset');
        return { rows: deliveryStatus ? [{ status: deliveryStatus, error: deliveryError }] : [] };
      }
      if (sql === reminders.STATE_SQL) return { rows: state.row.stateRow ? [state.row.stateRow] : [] };
      throw new Error(`unexpected: ${sql}`);
    },
  };
  return pool;
}

const NEW_ROW = {
  id: 5, email: 'new@example.test', released_at: new Date('2026-11-06T09:00:00Z'),
  linked_user_id: null, more_token: 'more-token', has_account: false, recipient_locale: null,
};

function capture(t) {
  const mail = require('../src/services/mail');
  const sent = [];
  t.mock.method(mail, 'sendWaitlistReminderMail', async (config, email, options) => { sent.push({ email, ...options }); });
  return sent;
}

test('a claimed reminder goes once, with a fresh sign-in link, the stop link and, on the last, Reply-To', async (t) => {
  const sent = capture(t);
  const pool = rowPool({ row: NEW_ROW });
  assert.deepEqual(await reminders.remindItem(CONFIG, pool, { signupId: 5, reminder: 1 }), { said: 'sent' });
  assert.equal(sent.length, 1);
  assert.equal(pool.state.links, 1, 'a fresh link was minted');
  assert.equal(sent[0].last, false);
  assert.equal(sent[0].hasAccount, false);
  assert.match(sent[0].signInToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(sent[0].signInExpiresAt instanceof Date);
  assert.equal(sent[0].stopUrl, reminders.stopUrl(CONFIG, NEW_ROW));
  assert.equal(sent[0].moreToken, 'more-token');
  // A second item for the same target finds it claimed and sends nothing.
  assert.deepEqual(await reminders.remindItem(CONFIG, pool, { signupId: 5, reminder: 1 }), { said: 'settled' });
  assert.equal(sent.length, 1);

  const last = rowPool({ row: { ...NEW_ROW, has_account: true, linked_user_id: 3 } });
  await reminders.remindItem(CONFIG, last, { signupId: 5, reminder: 2 });
  assert.equal(sent[1].last, true);
  assert.equal(sent[1].hasAccount, true);
  assert.equal(sent[1].signInToken, null, 'an account gets the sign-in form, no link');
  assert.equal(last.state.links, 0);
  assert.equal(sent[1].replyTo, 'support@usernodelabs.org');
});

test('a send the mailer refused before any provider gives its claim back; one that reached a provider keeps it', async (t) => {
  capture(t);
  for (const status of ['suppressed_rate_limit', 'no_transport', 'no_template']) {
    const pool = rowPool({ row: NEW_ROW, deliveryStatus: status, deliveryError: status === 'suppressed_rate_limit' ? 'global cap of 60 mails/hour reached' : null });
    assert.deepEqual(await reminders.remindItem(CONFIG, pool, { signupId: 5, reminder: 1 }), { said: status });
    assert.equal(pool.state.unclaims.length, 1, status);
    assert.match(pool.state.unclaims[0].sql, /SET reminder_1_sent_at = NULL\s+WHERE id = \$1 AND reminder_1_sent_at = \$2::timestamptz/);
    assert.deepEqual(pool.state.unclaims[0].params, [5, '2026-11-09 09:00:00.123456+00'], 'the exact claim, microseconds and all');
  }
  for (const status of ['sent', 'failed', 'suppressed_bounce', 'skipped_staging']) {
    const pool = rowPool({ row: NEW_ROW, deliveryStatus: status });
    await reminders.remindItem(CONFIG, pool, { signupId: 5, reminder: 1 });
    assert.equal(pool.state.unclaims.length, 0, status);
  }
  // The per-recipient rule refuses one only after that reminder already went
  // to the address: the stamp stays, or it would go twice.
  const already = rowPool({ row: NEW_ROW, deliveryStatus: 'suppressed_rate_limit', deliveryError: 'another waitlist_reminder mail went to this address 30s ago' });
  await reminders.remindItem(CONFIG, already, { signupId: 5, reminder: 1 });
  assert.equal(already.state.unclaims.length, 0);
  // A read of the outcome that fails after the send keeps the stamp and does
  // not throw, so the item is not run again to send a second one.
  const unread = rowPool({ row: NEW_ROW, readFails: true });
  assert.deepEqual(await reminders.remindItem(CONFIG, unread, { signupId: 5, reminder: 1 }), { said: 'sent' });
  assert.equal(unread.state.unclaims.length, 0);
});

test('the item does nothing unless reminders are On, and its steps keep the claim and the send', async (t) => {
  const sent = capture(t);
  const off = rowPool({ row: NEW_ROW, switchedOff: true });
  assert.deepEqual(await reminders.remindItem(CONFIG, off, { signupId: 5, reminder: 1 }), { said: 'off' });
  assert.equal(off.state.claims, 0);
  // A restart after the claim: the steps hand back the claim, and the send goes.
  const kept = { claim: { ...NEW_ROW, claimed_at: 'x' } };
  const steps = { once: async (key, fn) => (key in kept ? kept[key] : (kept[key] = await fn())) };
  const pool = rowPool({ row: NEW_ROW });
  await reminders.remindItem(CONFIG, pool, { signupId: 5, reminder: 1 }, steps);
  assert.equal(pool.state.claims, 0, 'not claimed again');
  assert.equal(sent.length, 1);
  // And once sent, run again, nothing more.
  await reminders.remindItem(CONFIG, pool, { signupId: 5, reminder: 1 }, steps);
  assert.equal(sent.length, 1);
});

// ── "Send a reminder now" ───────────────────────────────────────────────

test('Send a reminder now sends the next one, and refuses one signed in, stopped, or done with both', async (t) => {
  const sent = capture(t);
  const base = {
    id: 5, email: 'new@example.test', released_at: new Date(), reminder_1_sent_at: null, reminder_2_sent_at: null,
    reminders_stopped_at: null, test_release: false, suppressed: false, signed_in: false,
  };
  const refused = async (stateRow, code) => {
    const pool = rowPool({ row: { ...NEW_ROW, stateRow } });
    await assert.rejects(reminders.remindNow(CONFIG, pool, 5), (err) => {
      assert.ok(err instanceof reminders.ReminderRefused);
      assert.equal(err.code, code);
      assert.ok(err.message.length > 20, 'a sentence for the admin');
      return true;
    });
    assert.equal(pool.state.claims, 0, `${code}: nothing claimed`);
  };
  await refused({ ...base, signed_in: true }, 'signed_in');
  await refused({ ...base, reminders_stopped_at: new Date() }, 'stopped');
  await refused({ ...base, reminder_1_sent_at: new Date(), reminder_2_sent_at: new Date() }, 'had_both');
  await refused({ ...base, released_at: null }, 'not_admitted');
  await refused({ ...base, email: null }, 'no_email');
  await refused({ ...base, suppressed: true }, 'suppressed');
  await refused({ ...base, test_release: true }, 'not_found');
  await refused(null, 'not_found');

  const first = rowPool({ row: { ...NEW_ROW, stateRow: base } });
  assert.deepEqual(await reminders.remindNow(CONFIG, first, 5), { reminder: 1, kind: 'waitlist_reminder', status: 'sent', error: null, owed_again: false });
  const second = rowPool({ row: { ...NEW_ROW, stateRow: { ...base, reminder_1_sent_at: new Date() } } });
  assert.equal((await reminders.remindNow(CONFIG, second, 5)).kind, 'waitlist_reminder_last');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].last, true);
  // The admin's send skips the spacing ($2 true) but not the other rules.
  const raced = rowPool({ row: { ...NEW_ROW, stateRow: base }, claimable: false });
  await assert.rejects(reminders.remindNow(CONFIG, raced, 5), { code: 'changed' });
});

// ── The stop link ───────────────────────────────────────────────────────

test('the stop token is the row\'s and its address\'s, under the session secret', () => {
  const token = reminders.stopToken(5, 'new@example.test', 'k1');
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(reminders.stopToken(5, 'NEW@example.test', 'k1'), token, 'the address as stored, lowercased');
  assert.notEqual(reminders.stopToken(6, 'new@example.test', 'k1'), token, 'another row');
  assert.notEqual(reminders.stopToken(5, 'other@example.test', 'k1'), token, 'another address');
  assert.notEqual(reminders.stopToken(5, 'new@example.test', 'k2'), token, 'another secret');
  assert.equal(reminders.stopToken(5, 'new@example.test', null), null, 'no secret, no link');
  assert.equal(reminders.tokenMatches(5, 'new@example.test', token, 'k1'), true);
  assert.equal(reminders.tokenMatches(5, 'new@example.test', token.slice(0, 31), 'k1'), false);
  assert.equal(reminders.tokenMatches(5, 'new@example.test', 'x'.repeat(32), 'k1'), false);
  assert.match(reminders.stopUrl(CONFIG, { id: 5, email: 'new@example.test' }),
    /^https:\/\/app\.onhomeroom\.com\/mail\/reminders\/stop\?w=5&t=[A-Za-z0-9_-]{32}$/);
});

function stopPool(row) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/SELECT id, email FROM waitlist_signups WHERE id = \$1/.test(sql)) return { rows: row && row.id === params[0] ? [row] : [] };
      if (/SET reminders_stopped_at = NOW\(\)/.test(sql)) { writes.push(params); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected: ${sql}`);
    },
  };
}

async function serve(pool, fn) {
  const poolMod = require('../src/db/pool');
  const original = poolMod.getPool;
  poolMod.getPool = () => pool;
  const routesPath = require.resolve('../src/routes/waitlist-reminders');
  delete require.cache[routesPath];
  const { waitlistReminderRoutes } = require('../src/routes/waitlist-reminders');
  poolMod.getPool = original;
  const app = express();
  app.use(waitlistReminderRoutes(CONFIG));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the stop link: GET asks, POST stops, and a wrong token changes nothing', async () => {
  const row = { id: 5, email: 'new@example.test' };
  const pool = stopPool(row);
  const token = reminders.stopToken(5, row.email, CONFIG.sessionSecret);
  await serve(pool, async (base) => {
    const page = await fetch(`${base}/mail/reminders/stop?w=5&t=${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /<form method="post" action="\/mail\/reminders\/stop\?w=5&t=[A-Za-z0-9_-]{32}">/);
    assert.match(html, /Stop these reminders<\/button>/);
    assert.match(html, /<a href="\/\?login=1" style="color:#0a6ee0;font-size:15px">Sign in instead<\/a>/, 'signing in is a plain link');
    assert.equal((html.match(/background:#0a6ee0/g) || []).length, 1, 'one button on the page: Stop');
    assert.equal(pool.writes.length, 0, 'opening the link stops nothing');

    const stopped = await fetch(`${base}/mail/reminders/stop?w=5&t=${token}`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    const done = await stopped.text();
    assert.match(done, /<title>Reminders turned off<\/title>/);
    assert.match(done, /<h1[^>]*>Reminders turned off<\/h1>/, 'the heading says it worked');
    assert.match(done, /You won't get any more reminder emails about your Homeroom invite\. You can still sign in any time with this email\./);
    assert.doesNotMatch(done, /No more reminders/);
    assert.match(done, /<a href="\/\?login=1" style="color:#0a6ee0;font-size:15px">Sign in<\/a>/);
    assert.doesNotMatch(done, /background:#0a6ee0/, 'no button once stopped');
    assert.match(done, /This stops reminders for this address only\. Sign-in codes you ask for still arrive\./);
    assert.deepEqual(pool.writes, [[5]]);

    // The one-click POST a mail client sends from List-Unsubscribe.
    const oneClick = await fetch(`${base}/mail/reminders/stop?w=5&t=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(oneClick.status, 200);

    for (const query of [`w=5&t=${'x'.repeat(32)}`, `w=6&t=${token}`, 'w=5', `t=${token}`, 'w=abc&t=x']) {
      assert.equal((await fetch(`${base}/mail/reminders/stop?${query}`)).status, 400, `GET ${query}`);
      assert.equal((await fetch(`${base}/mail/reminders/stop?${query}`, { method: 'POST' })).status, 400, `POST ${query}`);
    }
    assert.equal(pool.writes.length, 2, 'only the right token wrote');
  });
});

test('the stop routes are mounted before sign-in, and the link is never rewritten for click tracking', () => {
  const server = read('server.js');
  const at = server.indexOf("require('./src/routes/waitlist-reminders').waitlistReminderRoutes(config)");
  assert.ok(at > 0, 'mounted');
  assert.ok(at < server.indexOf('app.use(authMiddleware(config))'), 'before authMiddleware');
  const before = process.env.PLATFORM_MAIL_TRACKING_SECRET;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = 'only-for-tests';
  try {
    const stop = reminders.stopUrl(CONFIG, { id: 5, email: 'new@example.test' });
    const message = buildMessage('waitlist_reminder', {
      ...ACTIONS.waitlist_reminder.sample, unsubscribeUrl: stop, trackingEnabled: true, messageId: 'a'.repeat(48),
    });
    assert.ok(message.html.includes(`href="${stop.replace(/&/g, '&amp;')}"`), 'the stop link stays as it is');
    assert.ok(!message.trackingLinks.includes(stop), 'and is not stored as a tracked link');
    assert.ok(message.trackingLinks.length > 0, 'the button is tracked');
    assert.equal(message.headers['List-Unsubscribe'], `<${stop}>`);
    assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  } finally {
    if (before === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET;
    else process.env.PLATFORM_MAIL_TRACKING_SECRET = before;
  }
  assert.ok(require('../src/services/mail/tracking').CREDENTIAL_PARAM);
  assert.equal(typeof tracking.decorate, 'function');
});

// ── Reply-To ────────────────────────────────────────────────────────────

test('only the last reminder carries Reply-To, a plain address, defaulting to support', () => {
  const last = buildMessage('waitlist_reminder_last', ACTIONS.waitlist_reminder_last.sample);
  assert.equal(last.replyTo, 'support@usernodelabs.org');
  assert.equal(buildMessage('waitlist_reminder', { ...ACTIONS.waitlist_reminder.sample, replyTo: 'x@y.test' }).replyTo, undefined);
  assert.equal(buildMessage('waitlist_released', ACTIONS.waitlist_released.sample).replyTo, undefined);
  assert.equal(buildMessage('waitlist_reminder_last', { ...ACTIONS.waitlist_reminder_last.sample, replyTo: 'a@b.test\r\nBcc: c@d.test' }).replyTo, undefined);
  assert.equal(replyAddress('Support <support@usernodelabs.org>'), null, 'one plain address');
  assert.equal(replyAddress(' support@usernodelabs.org '), 'support@usernodelabs.org');
  assert.equal(reminders.DEFAULT_REPLY_TO, 'support@usernodelabs.org');
  assert.match(read('src/config.js'), /mailReplyTo: \(process\.env\.PLATFORM_MAIL_REPLY_TO \|\| ''\)\.trim\(\) \|\| 'support@usernodelabs\.org'/);
});

test('every transport passes Reply-To on as its provider takes it', async (t) => {
  const message = buildMessage('waitlist_reminder_last', ACTIONS.waitlist_reminder_last.sample);
  const gmail = require('../src/services/mail/transports/gmail');
  const raw = gmail.buildRaw({ from: 'Homeroom <hello@x.test>', to: 'a@b.test', message, boundary: 'b' });
  assert.match(raw, /\r\nReply-To: support@usernodelabs\.org\r\n/);
  assert.doesNotMatch(gmail.buildRaw({ from: 'h@x.test', to: 'a@b.test', message: { ...message, replyTo: undefined }, boundary: 'b' }), /Reply-To/);

  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'r1', messageId: '<m1@brevo>' }), { status: 200 });
  });
  const payload = ACTIONS.waitlist_reminder_last.sample;
  const http = require('../src/services/mail/transports/http-api').create({
    TOPOCHAIN_MAIL_API_URL: 'https://mail.test/send', TOPOCHAIN_MAIL_API_KEY: 'k', TOPOCHAIN_MAIL_FROM: 'h@x.test',
  });
  await http.send({ to: 'a@b.test', kind: 'waitlist_reminder_last', ...payload });
  assert.equal(bodies[0].body.reply_to, 'support@usernodelabs.org', 'Resend: reply_to');
  const brevo = require('../src/services/mail/transports/brevo').create({ BREVO_API_KEY: 'k' }, { sender: 'Homeroom <h@x.test>' });
  await brevo.send({ to: 'a@b.test', kind: 'waitlist_reminder_last', ...payload });
  assert.deepEqual(bodies[1].body.replyTo, { email: 'support@usernodelabs.org' }, 'Brevo: replyTo');
  await http.send({ to: 'a@b.test', kind: 'waitlist_reminder', ...ACTIONS.waitlist_reminder.sample });
  assert.equal('reply_to' in bodies[2].body, false, 'none on the first reminder');

  const log = require('../src/services/logger');
  const lines = [];
  t.mock.method(log, 'info', (...args) => { lines.push(args); });
  await require('../src/services/mail/transports/log').create().send({ to: 'a@b.test', kind: 'waitlist_reminder_last', ...payload });
  assert.equal(lines.at(-1)[2].replyTo, 'support@usernodelabs.org', 'the log transport says it');
});

// ── The words ───────────────────────────────────────────────────────────

test('the reminder dates: a weekday within six days, else a short date; the link\'s day and month', () => {
  const now = '2026-11-09T09:00:00.000Z'; // a Monday
  assert.equal(admittedDay('2026-11-06T09:00:00Z', now), 'Friday');
  assert.equal(admittedDay('2026-11-03T10:00:00Z', now), 'Tuesday');
  assert.equal(admittedDay('2026-11-03T08:00:00Z', now), '3 Nov', 'six days and more is a date');
  assert.equal(admittedDay('2026-10-31T09:00:00Z', now), '31 Oct');
  assert.equal(admittedDay(null, now), '');
  assert.equal(dayMonth('2026-11-13T23:30:00Z'), '13 Nov', 'in UTC');
  assert.equal(dayMonth('nonsense'), '');
});

const EM_DASH = String.fromCharCode(0x2014);

test('reminder 1\'s copy: a short note, no date, no "still want in"', () => {
  const seed = englishTemplate('waitlist_reminder');
  assert.equal(seed.subject, 'You\'re in! Come see what we\'re building.');
  assert.equal(seed.preheader, 'Start an app, invite your friends, or jump into something already made.');
  const fresh = buildMessage('waitlist_reminder', ACTIONS.waitlist_reminder.sample);
  for (const line of [
    'Hey!',
    'Just a quick reminder that you\'re off the Homeroom waitlist!',
    'You can start an app with AI, invite your friends to help shape it, or jump into something someone else has already made.',
    'No big project needed. Start with something small and see where it goes.',
  ]) {
    assert.ok(fresh.html.includes(`>${line.replace(/'/g, '&#39;')}</p>`) || fresh.html.includes(`>${line}</p>`), line);
    assert.ok(fresh.text.includes(`${line}\n\n`), line);
  }
  assert.match(fresh.html, />Get started<\/a>/);
  assert.match(fresh.html, /<td style="text-align:left"><p style="margin:8px 0 20px"><a href=/, 'the button sits left, with the note (Drea, on 6508)');
  assert.doesNotMatch(fresh.html, /text-align:center/);
  assert.match(fresh.html, /See you in there,<br>Evan<\/p>/);
  assert.match(fresh.text, /Get started:\n\S+\n\nSee you in there,\nEvan/);
  assert.doesNotMatch(JSON.stringify(fresh), /Still want in|We let you in|works until|13 Nov/, 'no date, nothing pointed');
  assert.match(fresh.html, /You are receiving this because you were let in from the waitlist and haven't signed in yet\. We send one more reminder, then stop\. <a href="https:\/\/app\.onhomeroom\.com\/mail\/reminders\/stop\?w=1&amp;t=sample"[^>]*>Stop these reminders<\/a>/);
  assert.match(fresh.text, /Stop these reminders: https:\/\/app\.onhomeroom\.com\/mail\/reminders\/stop\?w=1&t=sample/);
  const account = buildMessage('waitlist_reminder', { ...ACTIONS.waitlist_reminder.sample, hasAccount: true, signInLink: false });
  assert.match(account.html, />Sign in with the email this was sent to\.<\/p>/);
  assert.match(account.html, />Sign in<\/a>/);
  assert.doesNotMatch(fresh.html, /Sign in with the email/, 'only an account is told to sign in');
  for (const m of [fresh, account]) assert.ok(!JSON.stringify(m).includes(EM_DASH));
});

test('the last reminder\'s copy: one last nudge, the date under the button, no reply line', () => {
  const seed = englishTemplate('waitlist_reminder_last');
  assert.equal(seed.subject, 'One last nudge 👋');
  assert.equal(seed.preheader, 'Your Homeroom invite is ready whenever you are.');
  const fresh = buildMessage('waitlist_reminder_last', ACTIONS.waitlist_reminder_last.sample);
  for (const line of [
    'Hey!',
    'Just wanted to send one last reminder that your Homeroom invite is ready.',
    'We\'re building Homeroom around a simple idea: apps shouldn\'t just be made for people. The people using them should be able to help make them better, too.',
    'And we\'d love for you to be part of that.',
    'And if now\'s not the right time, no worries. We won\'t keep sending reminders.',
  ]) {
    assert.ok(fresh.html.includes(`>${line.replace(/'/g, '&#39;')}</p>`) || fresh.html.includes(`>${line}</p>`), line);
    assert.ok(fresh.text.includes(line), line);
  }
  // The date sits under the button, with the way in after it.
  assert.match(fresh.html, />Get started<\/a><\/p><\/td><\/tr><\/table><p [^>]*>This button works until 13 Nov, but you can still sign in with this email anytime afterward\.<\/p>/);
  assert.match(fresh.text, /This link works until 13 Nov, but you can still sign in with this email anytime afterward\./);
  assert.match(fresh.html, /Hope to see you around,<br>Evan<\/p>/);
  assert.doesNotMatch(fresh.html, /text-align:center/, 'the button sits left here too');
  assert.doesNotMatch(JSON.stringify(fresh), /reply and tell me|We won't email you about this again|invite link/, 'no reply line, and no "invite link"');
  assert.match(fresh.html, /You are receiving this because you were let in from the waitlist and haven't signed in yet\. This is the last reminder\./);
  assert.doesNotMatch(fresh.html, /Stop these reminders/, 'nothing more to stop');
  assert.equal(fresh.headers['List-Unsubscribe'], `<${ACTIONS.waitlist_reminder_last.sample.unsubscribeUrl}>`);
  const account = buildMessage('waitlist_reminder_last', { ...ACTIONS.waitlist_reminder_last.sample, hasAccount: true });
  assert.match(account.html, />You can sign in any time with the email this was sent to\.<\/p>/);
  assert.match(account.html, />Sign in<\/a>/);
  const noLink = buildMessage('waitlist_reminder_last', { ...ACTIONS.waitlist_reminder_last.sample, signInLink: false });
  assert.match(noLink.html, />You can sign in any time with this email\.<\/p>/);
  for (const m of [fresh, account, noLink]) assert.ok(!JSON.stringify(m).includes(EM_DASH));
});

test('the admit email\'s copy: subject, smaller photo, Drea\'s line and no date, Get started, the tiles, the store links', () => {
  const seed = englishTemplate('waitlist_released');
  assert.equal(seed.subject, 'You\'re in. Make your first app on Homeroom');
  assert.equal(seed.preheader, 'Make and share apps with groups and friends. Here\'s how to get started.');
  const linked = buildMessage('waitlist_released', {
    url: 'https://app.onhomeroom.com/?signup=1&key=k', signInLink: true, signInExpiresAt: '2026-11-13T10:00:00Z',
    mobile: { ios: 'https://apps.apple.com/app/id6814786047', android: 'https://play.google.com/store/apps/details?id=com.onhomeroom.app' },
  });
  assert.match(linked.html, /width="200" height="150"/);
  assert.match(linked.html, /You're in<\/p>/);
  assert.match(linked.html, />Make and share apps with groups and friends\.<\/p><p style="margin:10px 0 0;font-size:15px;line-height:22px;color:#1c1c1e">Start building, invite your people, or explore what others are making\.<\/p><p style="margin:20px 0 0"><a /);
  assert.match(linked.html, />Get started<\/a>/);
  assert.match(linked.text, /Start building, invite your people, or explore what others are making\.\n\nGet started:\nhttps:/);
  assert.doesNotMatch(JSON.stringify(linked), /Jump in|works until|13 Nov/, 'no date in the admit email');
  for (const tile of ['Make an app with your friends', 'Build an app for your community', 'Join and help shape other community-owned apps']) {
    assert.ok(linked.html.includes(`>${tile}</td>`), tile);
    assert.ok(linked.text.includes(`- ${tile}`), tile);
  }
  assert.match(linked.html, />Get Homeroom on the App Store<\/a>/);
  assert.match(linked.html, />Get Homeroom on Google Play<\/a>\.<\/p>/);
  assert.match(linked.text, /Android: Get Homeroom on Google Play \(https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.onhomeroom\.app\)\./);
  assert.doesNotMatch(JSON.stringify(linked), /testing link|TestFlight/);
  assert.match(linked.html, /See you there,<br>Evan from Homeroom/);
  // An account: Sign in and its account line instead of Drea's.
  const account = buildMessage('waitlist_released', { url: 'https://app.onhomeroom.com/?login=1', hasAccount: true, signInLink: true, signInExpiresAt: '2026-11-13T10:00:00Z' });
  assert.doesNotMatch(account.html, /Start building/);
  assert.match(account.html, /Your account now has access\. Sign in with your waitlist email\./);
  assert.match(account.html, />Sign in<\/a>/);
  const plain = buildMessage('waitlist_released', { url: 'https://app.onhomeroom.com/?signup=1' });
  assert.match(plain.html, /Start building, invite your people/);
  assert.match(plain.html, /Opening it emails you a 6-digit code/);
  assert.doesNotMatch(JSON.stringify([linked, plain, account]), /Create my account|Welcome to Homeroom|272|Use and improve/);
});

test('the admit and reminder senders pass the link\'s expiry, and the reminders keep the admit mail\'s button', async (t) => {
  const mail = require('../src/services/mail');
  const sends = [];
  const config = { mailTransport: { provider: 'test', send: async (m) => { sends.push(m); } } };
  await mail.sendWaitlistReleaseMail(config, 'a@b.test', { signInToken: 'tok', signInExpiresAt: new Date('2026-11-13T10:00:00Z'), moreToken: 'mt' });
  assert.equal(sends[0].signInExpiresAt, '2026-11-13T10:00:00.000Z');
  assert.equal(sends[0].url, 'https://app.onhomeroom.com/?signup=1&t=mt&key=tok');
  await mail.sendWaitlistReminderMail(config, 'a@b.test', {
    hasAccount: true, signInToken: 'ignored', releasedAt: '2026-11-06T09:00:00Z', stopUrl: 'https://app.onhomeroom.com/mail/reminders/stop?w=1&t=x',
    replyTo: 'support@usernodelabs.org', now: '2026-11-09T09:00:00Z',
  });
  assert.equal(sends[1].kind, 'waitlist_reminder');
  assert.equal(sends[1].url, 'https://app.onhomeroom.com/?login=1');
  assert.equal(sends[1].signInLink, false);
  assert.equal('replyTo' in sends[1], false, 'the first reminder names none');
  await mail.sendWaitlistReminderMail(config, 'a@b.test', { last: true, replyTo: 'support@usernodelabs.org', stopUrl: 'https://app.onhomeroom.com/mail/reminders/stop?w=1&t=x' });
  assert.equal(sends[2].kind, 'waitlist_reminder_last');
  assert.equal(sends[2].replyTo, 'support@usernodelabs.org');
});

// ── The template version on deliveries ──────────────────────────────────

test('a send records the version and a digest of the stored template it rendered', async () => {
  const mail = require('../src/services/mail');
  const store = require('../src/services/mail/template-store');
  const snapshot = store.seededSnapshot();
  const resolved = store.resolve({ ...snapshot, templates: { ...snapshot.templates, waitlist_released: { ...snapshot.templates.waitlist_released, version: 4 } } }, 'waitlist_released', null);
  const used = mail.templateUsed(resolved);
  assert.equal(used.version, 4);
  assert.match(used.digest, /^[0-9a-f]{16}$/);
  // The words decide the digest: a refreshed copy at the same version is told apart.
  const edited = { ...resolved, english: { ...resolved.english, template: { ...resolved.english.template, subject: 'Other' } } };
  assert.notEqual(mail.templateUsed(edited).digest, used.digest);
  assert.equal(mail.templateUsed(edited).version, 4);
  assert.equal(mail.templateUsed({ template: null }), null);

  const index = read('src/services/mail/index.js');
  assert.match(index, /INSERT INTO mail_deliveries \(kind, recipient, provider, status, error, message_id, provider_message_id, tracking_links, engagement_tracked, template_version, template_digest\)/);
  assert.match(index, /const template = rendered\.plainBecause \? null : templateUsed\(worded\.resolved\);/);
  assert.match(read('src/db/migrations/waitlist-admit-reminders.sql'), /ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS template_version INTEGER;/);
});

test('every send through the door stores its template\'s version on its delivery row', async () => {
  const mail = require('../src/services/mail');
  const store = require('../src/services/mail/template-store');
  const snapshot = store.seededSnapshot();
  const rows = Object.values(snapshot.templates).map((row, i) => ({ ...row, id: i + 1, version: 3, status: 'live' }));
  const layouts = Object.values(snapshot.layouts).map((row) => ({ ...row, id: 1, version: 1, status: 'live' }));
  const inserts = [];
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO mail_deliveries/.test(sql)) { inserts.push(params); return { rows: [{ id: inserts.length }] }; }
      if (/FROM email_templates/.test(sql)) return { rows };
      if (/FROM email_layouts/.test(sql)) return { rows: layouts };
      return { rows: [] };
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  const poolMod = require('../src/db/pool');
  const original = poolMod.getPool;
  poolMod.getPool = () => pool;
  try {
    const config = { databaseUrl: 'postgres://fake/db', mailTransport: { provider: 'test', send: async () => {} } };
    await mail.send(config, { kind: 'otp', to: 'a@b.test', code: '123456' });
    const row = inserts.at(-1);
    assert.equal(row[3], 'sent');
    assert.equal(row[9], 3, 'template_version');
    assert.match(row[10], /^[0-9a-f]{16}$/, 'template_digest');
  } finally {
    poolMod.getPool = original;
  }
});
