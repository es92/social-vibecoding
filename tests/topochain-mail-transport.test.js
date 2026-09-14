// Topochain outbound mail: the transport behind mailer.js's hook, and the
// contract both of its callers depend on.
//
// The bug this pins: `config.topochainMailTransport` was a hook nothing
// ever filled, so BOTH senders generated a message and dropped it while
// their endpoints still reported success. That is not a bug in the
// endpoints — POST /api/auth/otp/request is always-200 by
// contract (SPEC 1667) precisely so it can't be used to enumerate
// accounts, and the waitlist join has the same shape — which is exactly
// why non-delivery was invisible.
//
// So the property under test is two-sided: mail must actually SEND when
// configured, and a broken transport must STILL not change either
// caller's response.
//
// Run with: node --test tests/topochain-mail-transport.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const transport = require(path.join(ROOT, 'src/services/topochain/mail-transport.js'));
const {
  sendOtpMail, sendWaitlistJoinMail, sendWaitlistCodeMail, sendWaitlistReleaseMail,
} = require(path.join(ROOT, 'src/services/topochain/mailer.js'));

const FULL_ENV = {
  TOPOCHAIN_MAIL_API_URL: 'https://mail.example.invalid/send',
  TOPOCHAIN_MAIL_API_KEY: 'test-key',
  TOPOCHAIN_MAIL_FROM: 'Homeroom <no-reply@example.invalid>',
};

// ─── create(): configured / unconfigured / partial ──────────────────────

test('create() returns null when nothing is configured', () => {
  // Must be null, not a throwing stub — mailer.js's "no transport
  // configured" branch (and its loud production error) keys off falsiness.
  assert.equal(transport.create({}), null);
});

test('create() returns null — and says which keys are missing — when partial', () => {
  for (const drop of Object.keys(FULL_ENV)) {
    const env = { ...FULL_ENV };
    delete env[drop];
    assert.equal(transport.create(env), null,
      `${drop} missing must not yield a half-working transport`);
  }
});

test('create() returns a transport with a send() when fully configured', () => {
  const t = transport.create(FULL_ENV);
  assert.ok(t && typeof t.send === 'function');
});

// ─── send(): both kinds reach the provider ──────────────────────────────

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

test('an OTP send POSTs the code to the provider with the bearer token', async () => {
  const calls = [];
  await withFetch(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {
    await transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'otp', code: '123456' });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FULL_ENV.TOPOCHAIN_MAIL_API_URL);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.to, ['a@b.invalid']);
  assert.equal(body.from, FULL_ENV.TOPOCHAIN_MAIL_FROM);
  assert.match(body.text, /123456/, 'the code must reach the user');
  assert.match(body.subject, /login code/i);
});

test('a waitlist send uses its own subject and carries no code', async () => {
  let body;
  await withFetch(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {
    await transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'waitlist_joined' });
  });
  assert.match(body.subject, /waitlist/i);
  assert.match(body.text, /waitlist/i);
  assert.doesNotMatch(body.text, /undefined/,
    'a missing code must not leak into the body as the string "undefined"');
});

test('a release send branches its copy on hasAccount and carries the link', async () => {
  const bodies = [];
  await withFetch(async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {
    const t = transport.create(FULL_ENV);
    await t.send({ to: 'a@b.invalid', kind: 'waitlist_released', url: 'https://x.invalid/#signup', hasAccount: false });
    await t.send({ to: 'a@b.invalid', kind: 'waitlist_released', url: 'https://x.invalid/#login', hasAccount: true });
  });
  assert.match(bodies[0].subject, /access is ready/i);
  assert.match(bodies[0].text, /create your account/i);
  assert.match(bodies[0].text, /https:\/\/x\.invalid\/#signup/);
  assert.match(bodies[1].text, /sign in/i);
  assert.match(bodies[1].text, /https:\/\/x\.invalid\/#login/);
  for (const b of bodies) {
    assert.doesNotMatch(b.text, /undefined/,
      'missing payload fields must not leak into the body as "undefined"');
  }
});

test('an unknown kind throws rather than sending a blank email', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: async () => '' }), async () => {
    await assert.rejects(
      () => transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'nope' }),
      /unknown mail kind/);
  });
});

test('a non-2xx provider reply throws (so mailer.js logs it)', async () => {
  await withFetch(
    async () => ({ ok: false, status: 422, text: async () => 'bad sender' }),
    async () => {
      await assert.rejects(
        () => transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'otp', code: '1' }),
        /HTTP 422/);
    });
});

// ─── mailer.js routes both senders through the hook ─────────────────────

test('sendOtpMail passes kind:"otp" explicitly', async () => {
  const seen = [];
  await sendOtpMail(
    { topochainMailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', '999111');
  assert.equal(seen.length, 1);
  // Explicit `kind` means a transport branches on one field rather than
  // inferring the message type from the presence of `code`.
  assert.equal(seen[0].kind, 'otp');
  assert.equal(seen[0].code, '999111');
  assert.equal(seen[0].to, 'a@b.invalid');
});

test('sendWaitlistJoinMail passes kind:"waitlist_joined"', async () => {
  const seen = [];
  await sendWaitlistJoinMail(
    { topochainMailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid');
  assert.equal(seen[0].kind, 'waitlist_joined');
});

test('a first join carries the stage-2 profile link; a re-join carries none', async () => {
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  const token = 'a'.repeat(48);
  await sendWaitlistJoinMail(cfg, 'a@b.invalid', { moreToken: token });
  await sendWaitlistJoinMail(cfg, 'a@b.invalid'); // idempotent re-join: no token
  assert.match(seen[0].url, new RegExp(`#more/${token}$`));
  assert.equal(seen[1].url, null);

  // ...and the transport copy actually includes it. The invitation reads
  // "increase your chances of getting into an earlier group" since Andrea's
  // 27 Aug 2026 copy pass; it used to say "Want in sooner?".
  const withLink = transport.buildMessage('waitlist_joined', { url: seen[0].url });
  assert.ok(withLink.text.includes(seen[0].url));
  assert.match(withLink.text, /increase your chances of getting into an earlier group/i);
  const withoutLink = transport.buildMessage('waitlist_joined', { url: null });
  assert.equal(
    /increase your chances of getting into an earlier group/i.test(withoutLink.text),
    false,
  );
});

test('sendWaitlistCodeMail passes kind:"waitlist_code" through the shim', async () => {
  // The shim is what src/routes/public-api.js requires, so a sender that
  // exists in src/services/mail/ but is missing from this re-export is a
  // TypeError at the first resend, not at boot.
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  await sendWaitlistCodeMail(cfg, 'a@b.invalid', { code: '424242', moreToken: 'a'.repeat(48) });
  await sendWaitlistCodeMail(cfg, 'a@b.invalid', { code: null, moreToken: 'a'.repeat(48) });
  assert.equal(seen[0].kind, 'waitlist_code');
  assert.equal(seen[0].code, '424242');
  assert.match(seen[0].confirmUrl, /\/api\/public\/waitlist\/confirm\/a{48}$/);
  // The already-confirmed shape: no code, so no confirm link either, and a
  // pointer to where they stand instead.
  assert.equal(seen[1].code, null);
  assert.equal(seen[1].confirmUrl, null);
  assert.match(seen[1].statusUrl, /#more\/a{48}$/);

  // And the transport can actually render it — an unknown kind throws here.
  const msg = transport.buildMessage('waitlist_code', seen[0]);
  assert.match(msg.text, /424242/);
});

test('sendWaitlistReleaseMail passes kind:"waitlist_released" and a signup/login link', async () => {
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  await sendWaitlistReleaseMail(cfg, 'a@b.invalid', { hasAccount: false, moreToken: 'tok123' });
  await sendWaitlistReleaseMail(cfg, 'a@b.invalid', { hasAccount: true });
  assert.equal(seen[0].kind, 'waitlist_released');
  // #1545: a QUERY, not a fragment. Following `/#signup` from a desktop mail
  // client landed on the home page while the same mail worked from a phone —
  // a link rewriter rebuilding the URL drops a fragment and keeps a query.
  // AuthScreens.enter() turns either spelling into the same hash route.
  //
  // #1548 adds `&t=<more_token>` to the no-account arm so the signup screen
  // can prefill the address and send a code without a second step. A TOKEN
  // rather than the address: it survives the rewriter for the same reason the
  // query does, and it keeps an email address out of server logs and
  // referrers, which for a waitlist is the fact people would least want
  // leaking. The token is already an unguessable capability delivered to that
  // same address.
  assert.match(seen[0].url, /\/\?signup=1&t=/, 'no account yet → account creation, carrying a token');
  assert.doesNotMatch(seen[0].url, /@/, 'the address itself never travels in the URL');
  assert.match(seen[1].url, /\/\?login=1$/, 'existing account → sign-in');
  for (const m of seen) {
    assert.doesNotMatch(m.url, /#/, 'nothing a link rewriter is free to drop');
  }
});

test('#1548: the release link carries an encoded token, never the address', async () => {
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  // The encoding concern is unchanged from when this carried the address:
  // anything interpolated raw can decode back to something else. It is the
  // token that travels now, so it is the token that must be encoded.
  await sendWaitlistReleaseMail(cfg, 'a+tag@b.invalid', {
    hasAccount: false, moreToken: 'tok+en/value',
  });
  const url = seen[0].url;
  assert.match(url, /\/\?signup=1&t=/, 'a query, which a link rewriter keeps');
  const t = url.split('&t=')[1];
  assert.ok(t, 'the link carries a token');
  assert.equal(t.includes('+'), false, 'encoded, not interpolated raw');
  assert.equal(t.includes('/'), false, 'encoded, not interpolated raw');
  assert.equal(decodeURIComponent(t), 'tok+en/value');
  // The whole point of the token: the address stays out of the URL, and so
  // out of server logs and referrers.
  assert.equal(url.includes('a+tag@b.invalid'), false);
  assert.equal(url.includes('a%2Btag%40b.invalid'), false);
});

test('#1548: with no token the link still works, just without the prefill', async () => {
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  // A signup row with no more_token (or a release path that cannot supply
  // one) must still send a usable link rather than an `&t=undefined`.
  await sendWaitlistReleaseMail(cfg, 'a@b.invalid', { hasAccount: false });
  assert.match(seen[0].url, /\/\?signup=1$/);
  assert.equal(seen[0].url.includes('undefined'), false);
});

test('an existing account gets no address in its link', async () => {
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  await sendWaitlistReleaseMail(cfg, 'a@b.invalid', { hasAccount: true });
  // They sign in with a password they already have; there is no code to send
  // and no field to prefill, so the address has no business in the URL.
  assert.equal(seen[0].url.includes('a@b.invalid'), false);
  assert.equal(seen[0].url.includes('a%40b.invalid'), false);
});

// ─── the always-success contract survives a broken transport ────────────

test('all senders swallow a throwing transport and resolve', async () => {
  const boom = { topochainMailTransport: { send: async () => { throw new Error('nope'); } } };
  // No rejection, no return value the caller must check — the endpoints
  // above these must be unable to tell delivery apart from non-delivery.
  assert.equal(await sendOtpMail(boom, 'a@b.invalid', '1'), undefined);
  assert.equal(await sendWaitlistJoinMail(boom, 'a@b.invalid'), undefined);
  assert.equal(await sendWaitlistCodeMail(boom, 'a@b.invalid', { code: '1' }), undefined);
  assert.equal(await sendWaitlistReleaseMail(boom, 'a@b.invalid', { hasAccount: false }), undefined);
});

test('all senders resolve with no transport at all, in production', async () => {
  const prod = { env: 'production' };
  assert.equal(await sendOtpMail(prod, 'a@b.invalid', '1'), undefined);
  assert.equal(await sendWaitlistJoinMail(prod, 'a@b.invalid'), undefined);
  assert.equal(await sendWaitlistReleaseMail(prod, 'a@b.invalid', { hasAccount: true }), undefined);
});

test('production never logs the raw OTP code', () => {
  // Global Constraints #6. The dev/staging branch deliberately DOES print
  // it so the flow stays completable by hand.
  //
  // Scans src/services/mail/index.js, which owns this branch now that the
  // mailer moved out of src/services/topochain/ (mailer.js is a re-export
  // shim). Pinned by path deliberately: a source scan that silently
  // targets a file with no production branch in it passes vacuously, so
  // assert the branch is actually THERE before asserting what it lacks.
  const src = fs.readFileSync(
    path.join(ROOT, 'src/services/mail/index.js'), 'utf8');
  const branchIdx = src.indexOf("config.env === 'production'");
  assert.ok(branchIdx > -1,
    'the production branch must live in src/services/mail/index.js — '
    + 'if it moved, retarget this scan rather than deleting it');
  const prodBranch = src.slice(branchIdx);
  const firstReturn = prodBranch.slice(0, prodBranch.indexOf('return;'));
  assert.ok(firstReturn.includes('log.error'),
    'sanity: the slice must actually contain the production log call');
  assert.doesNotMatch(firstReturn, /\bcode\b\s*[,}]/,
    'the production branch must not pass `code` into a log call');
});

test('the log transport is unreachable from a production auto-selection', () => {
  // The log transport DOES print the code — that is its whole purpose in
  // staging and dev. Global Constraints #6 is upheld structurally, by
  // select.js refusing to hand it to a production deploy on the default
  // (auto) setting, rather than by the transport self-censoring.
  const { chooseTransport } = require(path.join(ROOT, 'src/services/mail/select.js'));
  const prod = chooseTransport({ USERNODE_ENV: 'production', NODE_ENV: 'production' });
  assert.equal(prod.transport, null,
    'production with nothing configured must send NOTHING, not log the code');
  assert.equal(prod.provider, null);

  // ...whereas dev falls back to logging so a developer can read codes.
  const dev = chooseTransport({ NODE_ENV: 'development' });
  assert.equal(dev.provider, 'log');
});

// ─── describe(): what the admin screen renders ──────────────────────────

test('describe() reports presence only — never a value', () => {
  const d = transport.describe(FULL_ENV);
  assert.equal(d.configured, true);
  assert.deepEqual(d.missing, []);
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes('test-key'), 'the credential must never be returned');
  assert.ok(!serialized.includes(FULL_ENV.TOPOCHAIN_MAIL_API_URL));
});

test('describe() names the missing keys and the flows that break', () => {
  const d = transport.describe({});
  assert.equal(d.configured, false);
  assert.deepEqual(d.missing.sort(), [
    'TOPOCHAIN_MAIL_API_KEY', 'TOPOCHAIN_MAIL_API_URL', 'TOPOCHAIN_MAIL_FROM',
  ]);
  assert.equal(d.affectedFlows.length, 3,
    'every silently-broken flow must be named for the admin');
  assert.match(d.affectedFlows.join(' '), /login/i);
  assert.match(d.affectedFlows.join(' '), /waitlist/i);
  assert.match(d.affectedFlows.join(' '), /release/i);
});

test('the admin mail routes are registered ahead of GET /:key', () => {
  // Otherwise `mail-status` / `mail-activity` are swallowed as settings keys.
  const src = fs.readFileSync(
    path.join(ROOT, 'src/routes/topochain/admin/settings.js'), 'utf8');
  const keyIdx = src.indexOf("router.get('/api/v4/admin/settings/:key'");
  assert.ok(keyIdx > -1);
  for (const route of ['mail-status', 'mail-activity']) {
    const idx = src.indexOf(`'/api/v4/admin/settings/${route}'`);
    assert.ok(idx > -1, `${route} must exist`);
    assert.ok(idx < keyIdx, `${route} must be registered before /:key`);
  }
});

// ─── the new keys leak nothing either ───────────────────────────────────

test('the provider-aware describe() returns no credential value', () => {
  const mail = require(path.join(ROOT, 'src/services/mail'));
  const values = {
    GMAIL_OAUTH_CLIENT_ID: 'gmail-client-id-value',
    GMAIL_OAUTH_CLIENT_SECRET: 'gmail-client-secret-value',
    GMAIL_OAUTH_REFRESH_TOKEN: 'gmail-refresh-token-value',
    TOPOCHAIN_MAIL_API_URL: 'https://mail.example.invalid/send',
    TOPOCHAIN_MAIL_API_KEY: 'http-api-key-value',
    PLATFORM_MAIL_FROM: 'Homeroom <no-reply@example.invalid>',
  };
  const serialized = JSON.stringify(mail.describe(values));
  for (const [key, value] of Object.entries(values)) {
    if (key === 'PLATFORM_MAIL_FROM') continue; // the sender IS public
    assert.ok(!serialized.includes(value),
      `${key}'s value must never reach the admin screen`);
  }
  // The KEY NAMES are the opposite — the card can't tell an admin what to
  // set without them, so an unconfigured describe() must name them.
  const empty = mail.describe({});
  assert.deepEqual(empty.missing.sort(), [
    'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REFRESH_TOKEN',
  ]);
});
