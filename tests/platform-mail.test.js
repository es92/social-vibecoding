// Platform outbound mail — src/services/mail/.
//
// tests/topochain-mail-transport.test.js pins the ORIGINAL contract (the
// three senders, the always-200/never-throw guarantee, the legacy HTTP
// transport). This file pins what the mailer grew when it became the
// platform's mail service rather than one provider behind a hook:
//
//  - provider SELECTION, including the two rules that are safety
//    properties rather than preferences: a staging preview can never reach
//    a real provider, and production never falls back to logging (which
//    would print login codes — Global Constraints #6).
//  - the OUTBOUND THROTTLE. otp/request is unauthenticated and always-200,
//    and its express limiter is keyed by IP, so without a per-RECIPIENT
//    cap a distributed caller can aim unbounded mail at one address using
//    the platform as the amplifier.
//  - the GMAIL wire format, because a malformed RFC-2822 blob fails at the
//    provider, i.e. exactly where the always-200 contract hides it.
//  - the CONFIRM link: state change, idempotency, and the redirect.
//  - that the delivery LOG records every outcome, since it is the only
//    place a non-delivery is visible at all.
//
// Run with: node --test tests/platform-mail.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src/services/mail'));
const select = require(path.join(ROOT, 'src/services/mail/select.js'));
const rateLimit = require(path.join(ROOT, 'src/services/mail/rate-limit.js'));
const templates = require(path.join(ROOT, 'src/services/mail/templates.js'));
const gmail = require(path.join(ROOT, 'src/services/mail/transports/gmail.js'));

// ─── selection ──────────────────────────────────────────────────────────

const GMAIL_ENV = {
  GMAIL_OAUTH_CLIENT_ID: 'cid',
  GMAIL_OAUTH_CLIENT_SECRET: 'csecret',
  GMAIL_OAUTH_REFRESH_TOKEN: 'rtoken',
};
const HTTP_ENV = {
  TOPOCHAIN_MAIL_API_URL: 'https://mail.example.invalid/send',
  TOPOCHAIN_MAIL_API_KEY: 'test-key',
  TOPOCHAIN_MAIL_FROM: 'Homeroom <no-reply@example.invalid>',
};

test('a staging preview ALWAYS logs, even with a real provider configured', () => {
  // The single most important rule here. A staging preview runs against a
  // clone of production data (schema.sql's staging-privacy convention), so
  // reaching a real provider would mail real people from a branch nobody
  // has voted on.
  const chosen = select.chooseTransport({
    ...GMAIL_ENV, ...HTTP_ENV,
    USERNODE_ENV: 'staging',
    PLATFORM_MAIL_PROVIDER: 'gmail', // an explicit request is overridden too
  });
  assert.equal(chosen.provider, 'log');
  assert.equal(chosen.stagingLogOnly, true);
  assert.ok(chosen.transport, 'staging still has a transport — it just logs');
});

test('auto prefers gmail, falls back to http', () => {
  assert.equal(select.chooseTransport({ ...GMAIL_ENV, ...HTTP_ENV }).provider, 'gmail');
  assert.equal(select.chooseTransport({ ...HTTP_ENV }).provider, 'http');
});

test('an explicitly named provider is never silently downgraded', () => {
  // An operator who wrote PLATFORM_MAIL_PROVIDER=gmail wants to find out
  // it is misconfigured, not to be quietly moved onto another provider.
  const chosen = select.chooseTransport({
    ...HTTP_ENV, PLATFORM_MAIL_PROVIDER: 'gmail',
  });
  assert.equal(chosen.transport, null);
  assert.equal(chosen.provider, null);
  assert.equal(chosen.requested, 'gmail');
});

test('a partially configured provider is not a candidate', () => {
  const partial = { ...GMAIL_ENV };
  delete partial.GMAIL_OAUTH_REFRESH_TOKEN;
  // Falls THROUGH to http rather than building a half-working gmail.
  assert.equal(select.chooseTransport({ ...partial, ...HTTP_ENV }).provider, 'http');
});

test('gmail without a sender address is refused', () => {
  // Gmail rejects a send whose From the mailbox isn't authorised for, so a
  // transport with no resolved sender is worse than none: it would burn a
  // send and fail at the provider. resolveFrom always yields the committed
  // default, so this is only reachable by passing sender:null directly.
  assert.equal(gmail.create(GMAIL_ENV, { sender: null }), null);
  assert.ok(gmail.create(GMAIL_ENV, { sender: 'x@y.invalid' }));
});

test('the committed default sender is the single platform address', () => {
  assert.equal(select.DEFAULT_FROM, 'Homeroom <no-reply@onhomeroom.com>');
  // A fresh deploy that set nothing still has a correct From.
  assert.equal(select.resolveFrom({}), select.DEFAULT_FROM);
  // PLATFORM_MAIL_FROM wins; TOPOCHAIN_MAIL_FROM is the legacy fallback.
  assert.equal(select.resolveFrom({ TOPOCHAIN_MAIL_FROM: 'a@b.invalid' }), 'a@b.invalid');
  assert.equal(select.resolveFrom({
    PLATFORM_MAIL_FROM: 'new@b.invalid', TOPOCHAIN_MAIL_FROM: 'old@b.invalid',
  }), 'new@b.invalid');
});

test('an unrecognised PLATFORM_MAIL_PROVIDER degrades to auto, not to nothing', () => {
  const chosen = select.chooseTransport({ ...HTTP_ENV, PLATFORM_MAIL_PROVIDER: 'sendgridd' });
  assert.equal(chosen.provider, 'http', 'a typo must not stop all mail');
});

test('describe() reports staging honestly rather than green', () => {
  const d = select.describe({ ...GMAIL_ENV, USERNODE_ENV: 'staging' });
  assert.equal(d.stagingLogOnly, true);
  assert.equal(d.configured, false,
    'nothing is delivered, so the card must not read as configured');
  assert.equal(d.provider, 'log');
});

// ─── the throttle ───────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const ago = (ms) => new Date(T0 - ms);

test('a second OTP within a minute is suppressed; a later one is not', () => {
  const history = [{ status: 'sent', created_at: ago(10_000) }];
  assert.equal(rateLimit.decide({ kind: 'otp', now: T0, recipientHistory: history }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'otp', now: T0, recipientHistory: [{ status: 'sent', created_at: ago(90_000) }],
  }).allowed, true);
});

test('one address cannot be made to receive more than 5 codes an hour', () => {
  // The mail-bomb case: the express limiter is keyed by IP, so this is the
  // only cap that survives a distributed caller.
  const history = Array.from({ length: 5 }, (_, i) => ({
    status: 'sent', created_at: ago(5 * 60_000 * (i + 1)),
  }));
  const d = rateLimit.decide({ kind: 'otp', now: T0, recipientHistory: history });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /already sent/);
  assert.ok(d.retryAfterMs > 0);
});

test('failed and suppressed attempts do not consume a recipient budget', () => {
  // Otherwise one broken provider call would lock a user out of the retry
  // that would have worked.
  const history = Array.from({ length: 9 }, () => ({
    status: 'failed', created_at: ago(120_000),
  }));
  assert.equal(rateLimit.decide({ kind: 'otp', now: T0, recipientHistory: history }).allowed, true);
  const suppressed = [{ status: 'suppressed_rate_limit', created_at: ago(1_000) }];
  assert.equal(rateLimit.decide({ kind: 'otp', now: T0, recipientHistory: suppressed }).allowed, true);
});

test('a staging log-only send DOES consume budget', () => {
  // So a staging preview exercises the identical throttle it will meet in
  // production, instead of behaving more permissively than the real thing.
  const history = [{ status: 'skipped_staging', created_at: ago(1_000) }];
  assert.equal(rateLimit.decide({ kind: 'otp', now: T0, recipientHistory: history }).allowed, false);
});

test('a waitlist confirmation goes out once a day per address', () => {
  const history = [{ status: 'sent', created_at: ago(3 * 60 * 60 * 1000) }];
  assert.equal(rateLimit.decide({
    kind: 'waitlist_joined', now: T0, recipientHistory: history,
  }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'waitlist_joined', now: T0,
    recipientHistory: [{ status: 'sent', created_at: ago(25 * 60 * 60 * 1000) }],
  }).allowed, true);
});

test('a requested code is not swallowed by the join mail\'s daily cap', () => {
  // The bug the separate kind exists to prevent: reusing waitlist_joined for
  // a resend means the second send of the day is recorded
  // suppressed_rate_limit and silently dropped, which is precisely the
  // situation somebody pressing "send a new code" is already in.
  const joined = [{ status: 'sent', created_at: new Date(T0 - 2 * 60 * 1000) }];
  assert.equal(rateLimit.decide({
    kind: 'waitlist_joined', now: T0, recipientHistory: joined,
  }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code', now: T0, recipientHistory: joined,
  }).allowed, true, 'a different kind keeps its own history');
});

test('requested codes are one a minute, five a day, per address', () => {
  const at = (msAgo) => ({ status: 'sent', created_at: new Date(T0 - msAgo) });
  // The minute gap the endpoint's advertised cooldown corresponds to.
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code', now: T0, recipientHistory: [at(30 * 1000)],
  }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code', now: T0, recipientHistory: [at(61 * 1000)],
  }).allowed, true);
  // And the ceiling that bounds a determined one. Four earlier sends, the
  // most recent well outside the gap, so only the daily count can refuse it.
  const four = [2, 3, 4, 5].map((h) => at(h * 60 * 60 * 1000));
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code', now: T0, recipientHistory: four,
  }).allowed, true, 'the fifth of the day is allowed');
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code', now: T0, recipientHistory: [...four, at(6 * 60 * 60 * 1000)],
  }).allowed, false, 'the sixth is not');
});

test('the global ceiling outranks every per-recipient allowance', () => {
  const d = rateLimit.decide({ kind: 'otp', now: T0, globalCount: 300, maxPerHour: 300 });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /global cap/);
  // ...and is configurable.
  assert.equal(rateLimit.decide({
    kind: 'otp', now: T0, globalCount: 300, maxPerHour: 1000,
  }).allowed, true);
});

test('an unknown kind is still bounded globally, but is not dropped', () => {
  // A new kind of mail nobody added a rule for should go out, not vanish.
  assert.equal(rateLimit.decide({ kind: 'invoice_paid', now: T0 }).allowed, true);
  assert.equal(rateLimit.decide({
    kind: 'invoice_paid', now: T0, globalCount: 999, maxPerHour: 10,
  }).allowed, false);
});

// ─── send(): the delivery log and the never-throw contract ──────────────

// Minimal pool that records writes and answers the two history reads.
function makePool({ history = [], globalCount = 0, failWrites = false } = {}) {
  const inserted = [];
  return {
    inserted,
    async query(sql, params) {
      if (/INSERT INTO mail_deliveries/.test(sql)) {
        if (failWrites) throw new Error('disk on fire');
        inserted.push({
          kind: params[0], recipient: params[1], provider: params[2],
          status: params[3], error: params[4],
        });
        return { rowCount: 1 };
      }
      if (/SELECT status, created_at FROM mail_deliveries/.test(sql)) return { rows: history };
      if (/COUNT\(\*\)::int AS n FROM mail_deliveries/.test(sql)) {
        return { rows: [{ n: globalCount }] };
      }
      if (/DELETE FROM mail_deliveries/.test(sql)) return { rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// send() resolves a pool through src/db/pool.js, which we replace so no
// Postgres is needed. config.databaseUrl must be set for it to even try.
function withPool(pool, fn) {
  const poolPath = require.resolve('../src/db/pool');
  const original = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => pool },
    loaded: true, id: poolPath, filename: poolPath, paths: original ? original.paths : [],
  };
  return Promise.resolve(fn()).finally(() => {
    if (original) require.cache[poolPath] = original;
    else delete require.cache[poolPath];
  });
}

const cfg = (extra = {}) => ({ databaseUrl: 'postgres://fake/fake', env: 'test', ...extra });

test('a successful send is recorded as sent, with its provider', async () => {
  const pool = makePool();
  const sent = [];
  await withPool(pool, () => mail.send(
    cfg({ mailTransport: { provider: 'gmail', send: async (m) => { sent.push(m); } } }),
    { kind: 'otp', to: 'a@b.invalid', code: '424242' }
  ));
  assert.equal(sent.length, 1);
  assert.deepEqual(pool.inserted, [{
    kind: 'otp', recipient: 'a@b.invalid', provider: 'gmail', status: 'sent', error: null,
  }]);
});

test('a provider failure is recorded as failed and still resolves', async () => {
  const pool = makePool();
  const result = await withPool(pool, () => mail.send(
    cfg({ mailTransport: { provider: 'gmail', send: async () => { throw new Error('HTTP 550: nope'); } } }),
    { kind: 'otp', to: 'a@b.invalid', code: '1' }
  ));
  assert.equal(result, undefined, 'the always-200 caller must see nothing');
  assert.equal(pool.inserted[0].status, 'failed');
  assert.match(pool.inserted[0].error, /HTTP 550/);
});

test('a throttled send never reaches the provider but IS recorded', async () => {
  const pool = makePool({ history: [{ status: 'sent', created_at: new Date() }] });
  let reached = false;
  await withPool(pool, () => mail.send(
    cfg({ mailTransport: { provider: 'gmail', send: async () => { reached = true; } } }),
    { kind: 'otp', to: 'a@b.invalid', code: '1' }
  ));
  assert.equal(reached, false);
  assert.equal(pool.inserted[0].status, 'suppressed_rate_limit');
  assert.ok(pool.inserted[0].error, 'the reason must be visible to an admin');
});

test('a staging send is recorded as skipped_staging, not sent', async () => {
  const pool = makePool();
  await withPool(pool, () => mail.send(
    cfg({ mailTransport: { provider: 'log', send: async () => {} }, mailStagingLogOnly: true }),
    { kind: 'otp', to: 'a@b.invalid', code: '1' }
  ));
  assert.equal(pool.inserted[0].status, 'skipped_staging');
});

test('no transport at all is recorded as no_transport', async () => {
  const pool = makePool();
  await withPool(pool, () => mail.send(cfg(), { kind: 'otp', to: 'a@b.invalid', code: '1' }));
  assert.deepEqual(pool.inserted.map((r) => r.status), ['no_transport']);
});

test('a broken delivery log cannot break a send', async () => {
  const pool = makePool({ failWrites: true });
  let delivered = false;
  const result = await withPool(pool, () => mail.send(
    cfg({ mailTransport: { provider: 'gmail', send: async () => { delivered = true; } } }),
    { kind: 'otp', to: 'a@b.invalid', code: '1' }
  ));
  assert.equal(result, undefined);
  assert.equal(delivered, true, 'bookkeeping must never gate delivery');
});

test('the throttle fails OPEN when its history read breaks', async () => {
  // A missed rate-limit is a smaller problem than login codes stopping
  // because a query broke.
  const pool = {
    inserted: [],
    async query(sql, params) {
      if (/INSERT INTO mail_deliveries/.test(sql)) {
        pool.inserted.push({ status: params[3] });
        return { rowCount: 1 };
      }
      throw new Error('history read exploded');
    },
  };
  let delivered = false;
  await withPool(pool, () => mail.send(
    cfg({ mailTransport: { provider: 'gmail', send: async () => { delivered = true; } } }),
    { kind: 'otp', to: 'a@b.invalid', code: '1' }
  ));
  assert.equal(delivered, true);
});

test('send() with no database does not try to open a pool', async () => {
  // Several suites build a config that is only a mail transport. Asking
  // src/db/pool.js for a pool there would point a Pool at nothing.
  let asked = false;
  const pool = { query: async () => { asked = true; return { rows: [] }; } };
  let delivered = false;
  await withPool(pool, () => mail.send(
    { mailTransport: { provider: 'gmail', send: async () => { delivered = true; } } },
    { kind: 'otp', to: 'a@b.invalid', code: '1' }
  ));
  assert.equal(delivered, true);
  assert.equal(asked, false, 'no databaseUrl means no bookkeeping, not a crash');
});

test('an unknown kind never reaches a provider and never throws', async () => {
  let reached = false;
  const result = await mail.send(
    { mailTransport: { send: async () => { reached = true; } } },
    { kind: 'nope', to: 'a@b.invalid' }
  );
  assert.equal(result, undefined);
  assert.equal(reached, false, 'a blank email must not be sent');
});

// ─── templates ──────────────────────────────────────────────────────────

test('the join mail carries the CODE, the confirm link AND the survey link', async () => {
  const seen = [];
  await mail.sendWaitlistJoinMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', { moreToken: 'b'.repeat(48), code: '123456' });
  assert.match(seen[0].confirmUrl, /\/api\/public\/waitlist\/confirm\/b{48}$/);
  assert.match(seen[0].url, /#more\/b{48}$/);
  assert.equal(seen[0].code, '123456');

  const msg = templates.buildMessage('waitlist_joined', seen[0]);
  // Both ways to confirm ride in one mail: the code for a phone, where
  // leaving for the mail app loses the WebView's place, and the link for
  // a desktop, where it is one click. Either stamps the same row.
  assert.match(msg.text, /verification code is 123456/);
  assert.ok(msg.text.includes(seen[0].confirmUrl), 'the confirm CTA must be in the copy');
  // #1540: the sentence is shorter and the HTML half is a button, but the
  // text part must still carry the URL for a reader who cannot see HTML.
  assert.match(msg.text, /confirm in one tap/i);
  // Andrea's copy for the optional questions, and the rolling-groups
  // promise that replaced the placeholder "[September 9]" date — no wave
  // has been committed to, and a date that slips is worse than none.
  assert.match(msg.text, /increase your chances of getting into an earlier group/i);
  assert.match(msg.text, /rolling basis/i);
  assert.doesNotMatch(msg.text, /September/i);
  assert.ok(msg.html.includes('<a href='), 'the HTML part must link, not just print');
  // #1516: the code leads the mail, in the same large type the login-code
  // and resend mails use — not buried in a sentence three paragraphs down.
  assert.match(msg.html, /font-size:28px[^>]*>123456</);
  assert.ok(
    msg.html.indexOf('123456') < msg.html.indexOf('Thanks for joining'),
    'the code must come before the welcome copy in the HTML part');
  assert.ok(
    msg.text.indexOf('123456') < msg.text.indexOf('Thanks for joining'),
    'the code must come before the welcome copy in the text part');
});

test('a join mail with no code still renders, and prints no stray placeholder', async () => {
  const seen = [];
  await mail.sendWaitlistJoinMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', { moreToken: 'b'.repeat(48) });
  assert.equal(seen[0].code, null);
  const msg = templates.buildMessage('waitlist_joined', seen[0]);
  // Minting the code is best-effort — a failure must not cost the signer
  // their confirm link, nor leak a placeholder into the mail.
  assert.doesNotMatch(msg.text, /verification code/);
  assert.doesNotMatch(msg.text, /undefined|null/);
  assert.ok(msg.text.includes(seen[0].confirmUrl));
});

test('a re-join carries neither link and no stray "undefined"', async () => {
  const seen = [];
  await mail.sendWaitlistJoinMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } }, 'a@b.invalid');
  assert.equal(seen[0].confirmUrl, null);
  assert.equal(seen[0].url, null);
  const msg = templates.buildMessage('waitlist_joined', seen[0]);
  assert.doesNotMatch(msg.text, /undefined|null/);
  assert.equal(msg.text.includes('Confirm this email address'), false);
  assert.equal(msg.text.includes('Want in sooner?'), false);
});

test('a requested code mail carries the code and the one-click link', async () => {
  const seen = [];
  await mail.sendWaitlistCodeMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', { code: '424242', moreToken: 'c'.repeat(48) });
  assert.equal(seen[0].kind, 'waitlist_code');
  assert.match(seen[0].confirmUrl, /\/api\/public\/waitlist\/confirm\/c{48}$/);
  // No stage-2 survey link: this mail answers one question, and the offer
  // belongs to the join and to the screen after confirming.
  assert.equal(seen[0].statusUrl, null);

  const msg = templates.buildMessage('waitlist_code', seen[0]);
  assert.match(msg.text, /confirmation code is 424242/);
  assert.match(msg.text, /15 minutes/);
  // Issuing a code invalidates the previous one, and somebody with two
  // mails open needs to be told which to type.
  assert.match(msg.text, /earlier code has stopped working/i);
  assert.ok(msg.text.includes(seen[0].confirmUrl));
  assert.doesNotMatch(msg.text, /undefined|null/);
  assert.ok(msg.html.includes('424242'));
  // Not a second welcome: this is a code somebody asked for, and greeting
  // them again would misread the moment.
  assert.doesNotMatch(msg.text, /welcome/i);
});

test('an already-confirmed address is told so in the mail, and only there', async () => {
  // The single place the platform ever resolves the membership question.
  // The HTTP response cannot, so the inbox has to — it belongs to the
  // address itself, which is why saying it here leaks nothing.
  const seen = [];
  await mail.sendWaitlistCodeMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', { code: null, moreToken: 'c'.repeat(48) });
  assert.equal(seen[0].code, null);
  assert.equal(seen[0].confirmUrl, null, 'no code means nothing to confirm with');
  assert.match(seen[0].statusUrl, /#more\/c{48}$/);

  const msg = templates.buildMessage('waitlist_code', seen[0]);
  assert.match(msg.subject, /already confirmed/i);
  assert.match(msg.text, /already confirmed/i);
  assert.doesNotMatch(msg.text, /undefined|null/);
  assert.doesNotMatch(msg.text, /15 minutes/, 'there is no code, so there is no expiry to quote');
  assert.ok(msg.text.includes(seen[0].statusUrl));
});

test('a requested code mail renders with neither link', async () => {
  const seen = [];
  await mail.sendWaitlistCodeMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', { code: '424242' });
  assert.equal(seen[0].confirmUrl, null);
  const msg = templates.buildMessage('waitlist_code', seen[0]);
  assert.doesNotMatch(msg.text, /undefined|null/);
  assert.doesNotMatch(msg.text, /one click/i);
  assert.match(msg.text, /confirmation code is 424242/);
});

test('the password-reset mail carries the reset link and no secrets beyond it', async () => {
  const seen = [];
  const token = 'deadbeef'.repeat(8); // 64 hex chars, like the real token
  await mail.sendPasswordResetMail(
    { mailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', token);
  // Segment style (#reset-password/<token>), not a query string — the SPA
  // router (AuthScreens.routeFromHash) splits hash routes on '/'.
  assert.match(seen[0].url, /\/#reset-password\/(deadbeef){8}$/);
  assert.equal(seen[0].kind, 'password_reset');

  const msg = templates.buildMessage('password_reset', seen[0]);
  assert.ok(msg.text.includes(seen[0].url), 'the reset link must be in the copy');
  assert.match(msg.text, /30 minutes/);
  assert.match(msg.text, /you can ignore it/i);
  assert.ok(msg.html.includes('<a href='), 'the HTML part must link, not just print');
});

test('the release mail promises the code only on the arm that sends one (#1548)', () => {
  // Following the no-account link asks for a code straight away, so the copy
  // has to say so: the recipient is about to get a second email, and without
  // this line they read the code request as something going wrong.
  const fresh = templates.buildMessage('waitlist_released', {
    url: 'https://x.invalid/#signup/a%40b.invalid', hasAccount: false,
  });
  assert.match(fresh.text, /emails you a 6-digit code/);
  // The figure must track OTP_TTL_MS, so pin it rather than the sentence.
  assert.match(fresh.text, /expires in 10 minutes/);
  assert.match(fresh.html, /emails you a 6-digit code/);

  // Somebody who already has an account is sent to #login and never asked
  // for a code, so promising one there would be a plain lie.
  const returning = templates.buildMessage('waitlist_released', {
    url: 'https://x.invalid/#login', hasAccount: true,
  });
  assert.doesNotMatch(returning.text, /6-digit code/);
  assert.doesNotMatch(returning.html, /6-digit code/);
});

test('every kind renders subject, text and html with no leaked undefined', () => {
  const payloads = {
    otp: { code: '123456' },
    account_email: { code: '123456' },
    waitlist_joined: { url: 'https://x.invalid/#more/aa', confirmUrl: 'https://x.invalid/c/aa' },
    // The no-account arm, because that is the one that grew copy in #1548.
    waitlist_released: { url: 'https://x.invalid/#signup/a%40b.invalid', hasAccount: false },
    password_reset: { url: 'https://x.invalid/#reset-password?token=aa' },
    admin_test: {
      provider: 'gmail', from: 'Homeroom <no-reply@x.invalid>',
      sentAt: '2026-01-01T00:00:00.000Z', reference: 'abcd1234',
    },
  };
  for (const kind of templates.KINDS) {
    const m = templates.buildMessage(kind, payloads[kind]);
    assert.ok(m.subject && m.text && m.html, `${kind} must render all three parts`);
    assert.doesNotMatch(m.text, /undefined/, `${kind} text`);
    assert.doesNotMatch(m.html, /undefined/, `${kind} html`);
  }
});

// ─── the gmail wire format ──────────────────────────────────────────────

test('base64url output is URL-safe and unpadded', () => {
  // Gmail's {raw} field rejects standard base64: a `+`, `/` or `=` there is
  // a 400 the always-200 caller can never surface.
  const encoded = gmail.base64url(Buffer.from([0xfb, 0xff, 0xfe, 0x00]));
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(
    Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'),
    'fbfffe00');
});

test('the raw message is CRLF multipart/alternative with the right headers', () => {
  const raw = gmail.buildRaw({
    from: 'Homeroom <no-reply@onhomeroom.com>',
    to: 'a@b.invalid',
    message: { subject: 'Your Homeroom login code', text: 'code 123456', html: '<p>hi</p>' },
    boundary: 'bnd',
  });
  assert.match(raw, /^From: Homeroom <no-reply@onhomeroom\.com>\r\n/);
  assert.match(raw, /\r\nTo: a@b\.invalid\r\n/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="bnd"/);
  // text part before html part: clients pick the LAST part they can render.
  assert.ok(raw.indexOf('text/plain') < raw.indexOf('text/html'));
  assert.ok(raw.endsWith('--bnd--\r\n'), 'the final boundary must terminate');
  assert.equal(raw.includes('\n\n'), false, 'bare LF would break strict MTAs');
});

test('a non-ASCII subject is RFC 2047 encoded, not emitted raw', () => {
  assert.equal(gmail.encodeHeader('Your Homeroom login code'), 'Your Homeroom login code');
  const encoded = gmail.encodeHeader('Your Homeroom access — ready');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(
    Buffer.from(encoded.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'),
    'Your Homeroom access — ready');
});

test('a CRLF in a header value cannot inject a header', () => {
  const raw = gmail.buildRaw({
    from: 'ok@b.invalid',
    to: 'a@b.invalid\r\nBcc: victim@c.invalid',
    message: { subject: 'x\r\nX-Evil: 1', text: 't', html: 'h' },
    boundary: 'bnd',
  });
  // The injected text survives as inert content on its own header's line —
  // what must NOT happen is a new header line starting with it.
  const lines = raw.split('\r\n');
  assert.equal(lines.some((l) => /^Bcc:/i.test(l)), false, 'no smuggled Bcc header');
  assert.equal(lines.some((l) => /^X-Evil:/i.test(l)), false, 'no smuggled X-Evil header');
  assert.ok(lines.some((l) => l.startsWith('To: a@b.invalid Bcc:')),
    'the CRLF must be collapsed into the value, not dropped silently');
});

test('gmail mints one access token for many sends, and retries a 401 once', async () => {
  const calls = [];
  let tokenRequests = 0;
  let sendAttempts = 0;
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('oauth2.googleapis.com')) {
      tokenRequests += 1;
      assert.match(opts.body, /grant_type=refresh_token/);
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: `t${tokenRequests}`, expires_in: 3600 }) };
    }
    sendAttempts += 1;
    // First send is rejected as if the cached token were revoked.
    if (sendAttempts === 1) return { ok: false, status: 401, text: async () => 'invalid creds' };
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const t = gmail.create(GMAIL_ENV, { sender: 'Homeroom <no-reply@x.invalid>', fetchImpl });
  await t.send({ to: 'a@b.invalid', kind: 'otp', code: '111111' });
  assert.equal(tokenRequests, 2, 'a 401 forces exactly one extra refresh');
  assert.equal(sendAttempts, 2, 'and exactly one retry, not a loop');

  // A second send reuses the cached token: no third token request.
  await t.send({ to: 'a@b.invalid', kind: 'otp', code: '222222' });
  assert.equal(tokenRequests, 2);
});

test('gmail retries a 5xx once, then surfaces the provider status', async () => {
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 3600 }) };
    }
    attempts += 1;
    return { ok: false, status: 503, text: async () => 'backend error' };
  };
  const t = gmail.create(GMAIL_ENV, { sender: 'x@y.invalid', fetchImpl });
  await assert.rejects(() => t.send({ to: 'a@b.invalid', kind: 'otp', code: '1' }), /HTTP 503/);
  assert.equal(attempts, 2, 'one retry, then give up — no unbounded loop');
});

test('the OTP code never appears in a gmail failure message', async () => {
  // The thrown message is what index.js logs and stores in
  // mail_deliveries.error, so it must not carry the body.
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'secret-token', expires_in: 3600 }) };
    }
    return { ok: false, status: 400, text: async () => 'Invalid raw' };
  };
  const t = gmail.create(GMAIL_ENV, { sender: 'x@y.invalid', fetchImpl });
  const err = await t.send({ to: 'a@b.invalid', kind: 'otp', code: '987654' })
    .then(() => null, (e) => e);
  assert.ok(err);
  assert.equal(err.message.includes('987654'), false, 'the code must not reach a log');
  assert.equal(err.message.includes('secret-token'), false, 'nor the access token');
});

test('a gmail failure body is bounded in the surfaced error', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 3600 }) };
    }
    return { ok: false, status: 400, text: async () => 'x'.repeat(5000) };
  };
  const t = gmail.create(GMAIL_ENV, { sender: 'x@y.invalid', fetchImpl });
  const err = await t.send({ to: 'a@b.invalid', kind: 'otp', code: '1' })
    .then(() => null, (e) => e);
  assert.ok(err.message.length < 300, 'a huge provider body must not flood the log');
});

// ─── the confirm route + schema/manifest wiring ─────────────────────────

test('GET /api/public/waitlist/confirm/:token stamps once and redirects', async () => {
  // Drives the REAL router from src/routes/public-api.js over a loopback
  // listener against a mock pool, so this pins the actual route wiring
  // and not a re-implementation.
  const express = require('express');
  const TOKEN = 'c'.repeat(48);
  let confirmedAt = null;
  let updates = 0;

  const pool = {
    async query(sql, params) {
      // getSignupByMoreToken also selects the status timestamps now; match
      // the head of the column list so this mock is not re-broken by the
      // next additive widening.
      if (/SELECT id, email, answers[\s\S]*FROM waitlist_signups/.test(sql)) {
        return params[0] === TOKEN
          ? { rows: [{ id: 7, email: 'a@b.invalid', answers: null }] }
          : { rows: [] };
      }
      if (/UPDATE waitlist_signups[\s\S]*SET confirmed_at = COALESCE/.test(sql)) {
        updates += 1;
        // COALESCE semantics, in the mock: the first write wins.
        confirmedAt = confirmedAt || new Date('2026-01-01T00:00:00Z');
        return { rows: [{ id: 7, email: 'a@b.invalid', confirmed_at: confirmedAt }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => pool },
    loaded: true, id: poolPath, filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  // Fresh limiter instances: rate-limits.js's limiters are module-level
  // singletons with an in-memory store, and every test shares 127.0.0.1.
  delete require.cache[rateLimitsPath];
  delete require.cache[publicApiPath];

  let server;
  try {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    // manual: the point IS the 302, not where it lands.
    const get = (p) => fetch(`${base}${p}`, { redirect: 'manual' });

    const first = await get(`/api/public/waitlist/confirm/${TOKEN}`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), `/#more/${TOKEN}`);
    assert.equal(updates, 1);

    // Idempotent: a forwarded or re-opened link keeps the original stamp.
    const second = await get(`/api/public/waitlist/confirm/${TOKEN}`);
    assert.equal(second.status, 302);
    assert.equal(confirmedAt.toISOString(), '2026-01-01T00:00:00.000Z');

    // An unknown token 404s rather than redirecting to a blank survey.
    const unknown = await get(`/api/public/waitlist/confirm/${'d'.repeat(48)}`);
    assert.equal(unknown.status, 404);

    // A malformed token never reaches the lookup at all — the mock pool
    // would throw on any other statement, so a 404 here proves it.
    const malformed = await get('/api/public/waitlist/confirm/not-a-token');
    assert.equal(malformed.status, 404);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }
});

test('the confirm route is registered under the public prefix and 404s an unknown token', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/routes/public-api.js'), 'utf8');
  assert.match(src, /'\/api\/public\/waitlist\/confirm\/:token'/);
  // The Location header is built from a request param, so the regex guard
  // must be there in the route too, not only inside the service.
  const routeIdx = src.indexOf("'/api/public/waitlist/confirm/:token'");
  const routeBody = src.slice(routeIdx, routeIdx + 1800);
  assert.match(routeBody, /\^\[a-f0-9\]\{48\}\$/,
    'a token that reaches a Location header must be shape-checked at the route');
  assert.match(routeBody, /res\.redirect\(302/);
});

test('the schema declares mail_deliveries, its indexes and confirmed_at', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mail_deliveries/);
  // The throttle's read path and the admin card / retention sweep.
  assert.match(sql, /idx_mail_deliveries_recipient[\s\S]{0,120}recipient, kind, created_at DESC/);
  assert.match(sql, /idx_mail_deliveries_created/);
  // Private user content: a staging clone must start empty.
  assert.match(sql, /COMMENT ON TABLE mail_deliveries IS 'staging:private'/);
  assert.match(sql,
    /ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ/);

  // The COMMENT must come AFTER the CREATE, or re-applying the schema on a
  // fresh database aborts on a missing table.
  assert.ok(sql.indexOf('CREATE TABLE IF NOT EXISTS mail_deliveries')
    < sql.indexOf("COMMENT ON TABLE mail_deliveries IS 'staging:private'"));
});

test('mail_deliveries is NOT on the prod-debug deny lists', () => {
  // Deliberate: it holds no password, key or token, and "did that user's
  // login code go out" is exactly what an admin debugging session needs.
  const debug = require(path.join(ROOT, 'src/services/debug-access.js'));
  const denied = debug.DENIED_TABLES || new Set();
  const has = denied.has ? denied.has('mail_deliveries') : denied.includes('mail_deliveries');
  assert.equal(has, false);
});

test('dapp.json declares every Platform mail variable, credentials private', () => {
  const appManifest = require(path.join(ROOT, 'src/services/app-manifest.js'));
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const byKey = new Map(appManifest.readPlatformEnv(m).map((e) => [e.key, e]));

  for (const key of ['PLATFORM_MAIL_PROVIDER', 'PLATFORM_MAIL_FROM',
    'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET',
    'GMAIL_OAUTH_REFRESH_TOKEN', 'PLATFORM_MAIL_MAX_PER_HOUR']) {
    const entry = byKey.get(key);
    assert.ok(entry, `${key} must be declared so the console can offer it`);
    assert.equal(entry.group, 'Platform mail');
    // None of these may block boot: a deploy without mail must still come up.
    assert.equal(entry.required, false, `${key} must not be required`);
    assert.equal(entry.unwritable, false, `${key} must be editable in the console`);
  }

  // The two that can send mail as our domain must be encrypted at rest.
  for (const key of ['GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REFRESH_TOKEN',
    'TOPOCHAIN_MAIL_API_KEY']) {
    assert.equal(byKey.get(key).private, true, `${key} must be private`);
  }
  // The sender default is committed, so a fresh deploy has a correct From.
  assert.equal(byKey.get('PLATFORM_MAIL_FROM').default,
    'Homeroom <no-reply@onhomeroom.com>');
  // ...and code and manifest agree on it.
  assert.equal(byKey.get('PLATFORM_MAIL_FROM').default, select.DEFAULT_FROM);
});

test('the staging mail fixture only writes when USERNODE_ENV=staging', async () => {
  const { seedStagingPlatformMail } = require(path.join(ROOT, 'src/db/migrate.js'));
  const seen = [];
  const pool = { query: async (sql) => { seen.push(sql); return { rowCount: 1, rows: [] }; } };

  const original = process.env.USERNODE_ENV;
  try {
    delete process.env.USERNODE_ENV;
    await seedStagingPlatformMail(pool);
    assert.equal(seen.length, 0, 'a production boot must seed nothing');

    process.env.USERNODE_ENV = 'staging';
    await seedStagingPlatformMail(pool);
    const inserts = seen.filter((s) => /INSERT INTO mail_deliveries/.test(s));
    assert.equal(inserts.length, 11,
      'one row per status the card renders, plus three admin_test rows, plus '
      + 'the admission mail behind the admitted waitlist fixture, plus the '
      + 'delivered and throttled shapes of a requested waitlist code');
    for (const sql of inserts) {
      assert.match(sql, /WHERE NOT EXISTS/, 'a re-boot must not grow the table');
    }
    assert.ok(seen.some((s) => /INSERT INTO waitlist_signups/.test(s)));
  } finally {
    if (original === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = original;
  }
});

test('the staging fixture uses only unroutable, obviously fake addresses', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/db/migrate.js'), 'utf8');
  const fnIdx = src.indexOf('async function seedStagingPlatformMail');
  const body = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
  const emails = [...body.matchAll(/'([^']*@[^']*)'/g)].map((m) => m[1]);
  assert.ok(emails.length >= 5, 'sanity: the scrape found the seeded addresses');
  for (const email of emails) {
    // The suffix may be hyphenated AND numbered: the waitlist fixtures are
    // one per queue state (…-waitlist-confirmed, …-waitlist-admitted) and
    // one per thing the admin screen renders differently
    // (…-topochain-waitlist-3), and each still has to read as fake at a
    // glance.
    assert.match(email, /^staging-demo-[a-z0-9-]+@example\.invalid$/,
      `${email} must be visibly fake and unroutable (RFC 2606)`);
  }
});

test('config exposes the resolved transport under both names', () => {
  // `topochainMailTransport` was the original hook. It stays as an alias so
  // nothing that reads it breaks, and so the injected-transport tests keep
  // working.
  const src = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
  assert.match(src, /mailTransport: chosen\.transport/);
  assert.match(src, /topochainMailTransport: chosen\.transport/);
  assert.match(src, /PLATFORM_MAIL=/, 'boot must say which provider is live');
});

// ─── sendTest: the diagnostic sibling ───────────────────────────────────
//
// send() must stay silent about what happened (SPEC 1667). sendTest() must
// say exactly what happened. These pin the difference, because the easy
// mistake — "just add a flag to send()" — would put a checkable return
// value on the path the unauthenticated OTP endpoint uses.

test('sendTest reports a successful send with provider, from and copy', async () => {
  const seen = [];
  const outcome = await mail.sendTest({
    mailStagingLogOnly: false,
    mailTransport: {
      provider: 'gmail',
      from: 'Homeroom <no-reply@x.invalid>',
      send: async (m) => { seen.push(m); },
    },
  }, { to: 'ops@example.invalid' });

  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.provider, 'gmail');
  assert.equal(outcome.from, 'Homeroom <no-reply@x.invalid>');
  assert.equal(seen[0].kind, 'admin_test');
  assert.equal(seen[0].to, 'ops@example.invalid');
  assert.match(outcome.message.subject, /test email/i);
  assert.ok(outcome.reference, 'the body and the outcome share a reference id');
  assert.ok(outcome.message.text.includes(outcome.reference));
  assert.ok(Number.isFinite(outcome.durationMs));
});

test('sendTest reports a provider refusal as failed rather than throwing', async () => {
  const outcome = await mail.sendTest({
    mailStagingLogOnly: false,
    mailTransport: {
      provider: 'gmail',
      send: async () => { throw new Error('HTTP 401: invalid_grant'); },
    },
  }, { to: 'ops@example.invalid' });

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /invalid_grant/);
});

test('sendTest reports no_transport instead of pretending to send', async () => {
  const outcome = await mail.sendTest({}, { to: 'ops@example.invalid' });
  assert.equal(outcome.status, 'no_transport');
  assert.match(outcome.error, /No mail transport/);
});

test('sendTest reports skipped_staging when staging log-only is on', async () => {
  const outcome = await mail.sendTest({
    mailStagingLogOnly: true,
    mailTransport: { provider: 'log', send: async () => {} },
  }, { to: 'ops@example.invalid' });
  assert.equal(outcome.status, 'skipped_staging');
});

test('sendTest surfaces a provider message id when the transport returns one', async () => {
  const outcome = await mail.sendTest({
    mailStagingLogOnly: false,
    mailTransport: {
      provider: 'gmail',
      send: async () => ({ providerMessageId: '18f0c0ffee' }),
    },
  }, { to: 'ops@example.invalid' });
  assert.equal(outcome.providerMessageId, '18f0c0ffee');
});

test('sendTest never throws, whatever the transport does', async () => {
  for (const send of [
    async () => { throw new Error('boom'); },
    async () => { throw 'a string, not an Error'; }, // eslint-disable-line no-throw-literal
    () => { throw new Error('sync throw'); },
  ]) {
    const outcome = await mail.sendTest(
      { mailStagingLogOnly: false, mailTransport: { provider: 'x', send } },
      { to: 'ops@example.invalid' });
    assert.equal(outcome.status, 'failed');
  }
  // A missing recipient is a caller bug, not a crash.
  const empty = await mail.sendTest({}, {});
  assert.equal(empty.status, 'invalid_recipient');
});

test('send() keeps its silent, never-throw contract', async () => {
  // The regression this guards: making sendTest() a flag on send() would
  // give the unauthenticated always-200 OTP endpoint a checkable value.
  assert.equal(
    await mail.send({ mailTransport: { provider: 'x', send: async () => { throw new Error('nope'); } } },
      { kind: 'otp', to: 'a@b.invalid', code: '1' }),
    undefined, 'send() must resolve undefined even when the provider fails');
  assert.equal(
    await mail.send({ mailTransport: { provider: 'x', send: async () => ({ providerMessageId: 'id' }) } },
      { kind: 'otp', to: 'a@b.invalid', code: '1' }),
    undefined, 'a transport detail return must not leak through send()');
  const src = fs.readFileSync(path.join(ROOT, 'src/services/mail/index.js'), 'utf8');
  assert.match(src, /async function sendTest\(/, 'sendTest is a sibling function');
});

test('the admin_test body carries nothing an attacker could use', () => {
  const m = templates.buildMessage('admin_test', {
    provider: 'gmail', from: 'no-reply@x.invalid',
    sentAt: '2026-01-01T00:00:00.000Z', reference: 'abcd1234',
  });
  assert.doesNotMatch(m.text, /\b\d{6}\b/, 'no OTP-shaped value');
  assert.doesNotMatch(m.text, /https?:\/\//, 'no link to follow');
  assert.match(m.text, /no action is needed/i);
});

test('admin_test has its own per-recipient throttle rule', () => {
  const rule = rateLimit.RULES.admin_test;
  assert.ok(rule, 'a kind with no rule is bounded only by the global cap');
  assert.equal(rule.minGapMs, 30 * 1000);
  assert.equal(rule.perWindow, 10);
  assert.equal(rule.windowMs, rateLimit.HOUR_MS);

  // The gap actually fires.
  const now = Date.now();
  const decision = rateLimit.decide({
    kind: 'admin_test',
    now,
    recipientHistory: [{ status: 'sent', created_at: new Date(now - 5000) }],
  });
  assert.equal(decision.allowed, false);
});
