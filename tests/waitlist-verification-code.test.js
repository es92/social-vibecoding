// src/services/waitlist.js — the email verification CODE that rides beside
// the one-click confirm link. The onboarding doc's "Simpler waitlist flow
// proposal" asks for "Email + verification code"; what shipped was a link
// only, which is one click on desktop and awkward on a phone, where leaving
// for the mail app loses the WebView's place. Both work now and both stamp
// the same confirmed_at.
//
// Same shape and same guarantees as mobile_otp_codes, deliberately: bcrypt
// hashed, one live code per address, capped attempts, short expiry.
//
// Contracts guarded here:
//
//   1. The plaintext code is returned to the caller and NEVER stored — only
//      its bcrypt hash lands in the table.
//   2. Issuing a second code invalidates the first, so a forwarded or
//      re-opened older mail cannot confirm.
//   3. A wrong code increments attempts and, past the cap, the RIGHT code
//      stops working too. Every failure returns the same null — unknown
//      email, wrong code, expired, consumed, capped — so the endpoint can
//      never be used to test whether an address is on the list.
//   4. Confirming by code is idempotent with confirming by link: both stamp
//      confirmed_at and the FIRST timestamp wins.
//   5. Contract 2 has a 60-second hole in it, and hasReusableCode is what
//      fills it (#2201). Issuing DELETEs before it INSERTs, but the mail
//      layer only decides afterwards and allows one waitlist_code a minute
//      per address — so a second ask inside the gap invalidated the code
//      that had actually been delivered and then mailed nothing to replace
//      it. Inside the window the live code is reported reusable and left
//      alone, which is the same fix services/email-signup.js already made
//      for account OTPs.
//
// Service-level tests against a stateful in-memory mock pool — no live DB,
// same idiom as tests/onboarding-waitlist.test.js.
//
// Run with: node --test tests/waitlist-verification-code.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  joinWaitlist,
  issueVerificationCode,
  confirmSignupByCode,
  confirmSignupByMoreToken,
  getSignupByEmail,
  hasReusableCode,
  MAX_CODE_ATTEMPTS,
  CODE_REUSE_WINDOW_SECONDS,
} = require('../src/services/waitlist');

// ─── Stateful mock pool ───────────────────────────────────────────────
//
// Simulates the rows the code paths touch:
//   state.signups — Map(email -> { id, email, more_token, confirmed_at })
//   state.codes   — [{ id, email, code_hash, attempts, expires_at, consumed_at }]

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeState() {
  return { signups: new Map(), codes: [], nextSignupId: 1, nextCodeId: 1 };
}

function makePool(state) {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.startsWith('INSERT INTO waitlist_signups')) {
      const [email, , answers, moreToken] = params;
      if (state.signups.has(email)) return { rowCount: 0, rows: [] };
      const submittedAt = new Date();
      state.signups.set(email, {
        id: state.nextSignupId++,
        email,
        answers: answers ? JSON.parse(answers) : null,
        more_token: moreToken || null,
        submitted_at: submittedAt,
        confirmed_at: null,
        released_at: null,
        linked_user_id: null,
      });
      // RETURNING submitted_at. A conflict returns no row at all, which is
      // how joinWaitlist tells the two apart.
      return { rowCount: 1, rows: [{ submitted_at: submittedAt }] };
    }

    if (sql.startsWith('DELETE FROM waitlist_verification_codes')) {
      const [email] = params;
      state.codes = state.codes.filter((c) => !(c.email === email && c.consumed_at == null));
      return { rowCount: 1, rows: [] };
    }

    if (sql.startsWith('INSERT INTO waitlist_verification_codes')) {
      const [email, hash] = params;
      state.codes.push({
        id: state.nextCodeId++,
        email,
        code_hash: hash,
        attempts: 0,
        // The real columns are NOW() + INTERVAL '15 minutes' and a NOW()
        // default. created_at is not decoration here: it is what the reuse
        // window in hasReusableCode() measures.
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        created_at: new Date(),
        consumed_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    // Must precede the live-code read below: that branch's substring is a
    // prefix of this one's, so ordering is what keeps them apart.
    if (sql.startsWith('SELECT 1 FROM waitlist_verification_codes')) {
      const [email] = params;
      const windowMs = CODE_REUSE_WINDOW_SECONDS * 1000;
      const reusable = state.codes
        .filter((c) => c.email === email
          && c.consumed_at == null
          && c.attempts === 0
          && c.expires_at > new Date()
          && Date.now() - c.created_at.getTime() < windowMs)
        .sort((a, b) => b.id - a.id);
      return { rows: reusable.length ? [{ '?column?': 1 }] : [] };
    }

    if (sql.includes('FROM waitlist_verification_codes WHERE email = $1 AND consumed_at IS NULL')) {
      const [email] = params;
      const live = state.codes
        .filter((c) => c.email === email && c.consumed_at == null)
        .sort((a, b) => b.id - a.id);
      const c = live[0];
      return {
        rows: c
          ? [{ id: c.id, code_hash: c.code_hash, attempts: c.attempts, expires_at: c.expires_at }]
          : [],
      };
    }

    if (sql.includes('SET attempts = attempts + 1 WHERE id = $1')) {
      const [id] = params;
      const c = state.codes.find((r) => r.id === id);
      if (c) c.attempts += 1;
      return { rowCount: c ? 1 : 0, rows: [] };
    }

    if (sql.includes('SET consumed_at = NOW() WHERE id = $1')) {
      const [id] = params;
      const c = state.codes.find((r) => r.id === id);
      if (c) c.consumed_at = new Date();
      return { rowCount: c ? 1 : 0, rows: [] };
    }

    if (sql.includes('SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE email = $1')) {
      const [email] = params;
      const s = state.signups.get(email);
      if (!s) return { rowCount: 0, rows: [] };
      s.confirmed_at = s.confirmed_at || new Date();
      // The whole state tuple, matching the RETURNING #1538 widened: the
      // confirm route derives its status block straight off this row.
      return {
        rowCount: 1,
        rows: [{
          id: s.id,
          email: s.email,
          submitted_at: s.submitted_at,
          confirmed_at: s.confirmed_at,
          released_at: s.released_at,
          linked_user_id: s.linked_user_id,
          more_token: s.more_token,
        }],
      };
    }

    // The widened column set (#2201): the join endpoint builds its status
    // block straight off this row, so submitted_at / released_at /
    // linked_user_id come back with it rather than costing a second query.
    if (sql.startsWith('SELECT id, email, submitted_at, confirmed_at, released_at, linked_user_id, more_token FROM waitlist_signups WHERE email = $1')) {
      const [email] = params;
      const s = state.signups.get(email);
      return {
        rows: s
          ? [{
            id: s.id,
            email: s.email,
            submitted_at: s.submitted_at,
            confirmed_at: s.confirmed_at,
            released_at: s.released_at,
            linked_user_id: s.linked_user_id,
            more_token: s.more_token,
          }]
          : [],
      };
    }

    if (sql.includes('WHERE more_token = $1')) {
      const [token] = params;
      const s = [...state.signups.values()].find((r) => r.more_token === token);
      return { rows: s ? [{ id: s.id, email: s.email, answers: s.answers }] : [] };
    }

    if (sql.includes('SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = $1')) {
      const [id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      if (!s) return { rowCount: 0, rows: [] };
      s.confirmed_at = s.confirmed_at || new Date();
      return { rowCount: 1, rows: [{ id: s.id, email: s.email, confirmed_at: s.confirmed_at }] };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

function fixture() {
  const state = makeState();
  return { state, pool: makePool(state) };
}

// ─── 1. The plaintext code never lands in the table ───────────────────

test('the plaintext code is returned but never stored', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(state.codes.length, 1);
  assert.notEqual(state.codes[0].code_hash, code);
  // A bcrypt hash, not the digits with extra characters around them.
  assert.match(state.codes[0].code_hash, /^\$2[aby]\$/);
});

test('issueVerificationCode normalizes the address it keys on', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  await issueVerificationCode(pool, '  A@Example.COM ');
  assert.equal(state.codes[0].email, 'a@example.com');
});

test('issueVerificationCode refuses a non-address rather than minting a code', async () => {
  const { pool, state } = fixture();
  await assert.rejects(() => issueVerificationCode(pool, 'not-an-email'));
  assert.equal(state.codes.length, 0);
});

// ─── 2. One live code per address ─────────────────────────────────────

test('issuing a second code invalidates the first', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const first = await issueVerificationCode(pool, 'a@example.com');
  const second = await issueVerificationCode(pool, 'a@example.com');
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', first), null);
  assert.ok(await confirmSignupByCode(pool, 'a@example.com', second));
});

// ─── 3. Failures are indistinguishable, and the cap is real ───────────

test('the right code confirms the signup and returns its stage-2 token', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  const row = await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(row);
  assert.ok(row.confirmed_at);
  assert.match(row.more_token, /^[a-f0-9]{48}$/);
});

test('a used code cannot be used twice', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  assert.ok(await confirmSignupByCode(pool, 'a@example.com', code));
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('too many wrong guesses kill the code even for the right answer', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
    assert.equal(await confirmSignupByCode(pool, 'a@example.com', '000000'), null);
  }
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('an expired code is refused', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const code = await issueVerificationCode(pool, 'a@example.com');
  state.codes[0].expires_at = new Date(Date.now() - 1000);
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('an unknown email returns the same null a wrong code does', async () => {
  const { pool } = fixture();
  assert.equal(await confirmSignupByCode(pool, 'nobody@example.com', '123456'), null);
});

test('a malformed code never reaches the database', async () => {
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  await issueVerificationCode(pool, 'a@example.com');

  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, 123456]) {
    assert.equal(await confirmSignupByCode(pool, 'a@example.com', bad), null);
  }
});

// ─── 4. Code and link are one confirmation, not two ───────────────────

test('the link and the code stamp the same row, and the first wins', async () => {
  const { pool, state } = fixture();
  const { moreToken } = await joinWaitlist(pool, { email: 'a@example.com' });

  const byLink = await confirmSignupByMoreToken(pool, moreToken);
  assert.ok(byLink.confirmed_at);
  const first = state.signups.get('a@example.com').confirmed_at;

  const code = await issueVerificationCode(pool, 'a@example.com');
  const byCode = await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(byCode);
  assert.equal(state.signups.get('a@example.com').confirmed_at, first);
});

// ─── 4b. A code for an ALREADY-confirmed row (#1538) ──────────────────
//
// Check-my-status runs this path on every use: whoever asks to read their
// status has confirmed already, so the code they type lands on a row whose
// confirmed_at is set. That has to be a normal read, not a re-confirmation
// and not a refusal.

test('a code authenticates an already-confirmed row without moving confirmed_at', async () => {
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const first = await issueVerificationCode(pool, 'a@example.com');
  await confirmSignupByCode(pool, 'a@example.com', first);
  const stamped = state.signups.get('a@example.com').confirmed_at;
  assert.ok(stamped);

  // A second code, minted for a status read rather than a confirmation.
  const again = await issueVerificationCode(pool, 'a@example.com');
  const row = await confirmSignupByCode(pool, 'a@example.com', again);
  assert.ok(row, 'a confirmed row still authenticates');
  assert.equal(state.signups.get('a@example.com').confirmed_at, stamped,
    'the FIRST timestamp is the true one; a status read must not restamp it');
});

test('the confirm read carries the whole state tuple, not just the token', async () => {
  // #1538 widened the RETURNING so the route can answer "where do I stand"
  // off this one row. A second round trip would be a second chance for the
  // two answers to disagree.
  const { pool, state } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const signup = state.signups.get('a@example.com');
  signup.released_at = new Date();
  signup.linked_user_id = 900001;

  const code = await issueVerificationCode(pool, 'a@example.com');
  const row = await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(row);
  for (const field of ['submitted_at', 'confirmed_at', 'released_at', 'linked_user_id', 'more_token']) {
    assert.ok(field in row, `${field} is missing from the confirm read`);
  }
  assert.equal(row.linked_user_id, 900001);
  assert.ok(row.released_at);
});

// ─── 5. The by-address lookup the resend endpoint decides on ──────────

test('getSignupByEmail answers null for an address that never joined', async () => {
  const { pool } = fixture();
  assert.equal(await getSignupByEmail(pool, 'nobody@example.com'), null);
});

test('getSignupByEmail normalizes before it looks up', async () => {
  // The endpoint in front of it takes whatever was typed into a form, and
  // the column stores the normalized form. Without this, "A@Example.COM "
  // would look like a stranger and be answered with silence.
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const row = await getSignupByEmail(pool, '  A@Example.COM ');
  assert.ok(row);
  assert.equal(row.email, 'a@example.com');
});

test('getSignupByEmail refuses a non-address without touching the database', async () => {
  // The mock throws on an unhandled query, so reaching the pool at all
  // would fail here rather than return null.
  const { pool } = fixture();
  assert.equal(await getSignupByEmail(pool, 'not-an-email'), null);
  assert.equal(await getSignupByEmail(pool, ''), null);
  assert.equal(await getSignupByEmail(pool, null), null);
});

test('getSignupByEmail reports confirmed state and the stage-2 token', async () => {
  // The fields the callers decide on: that the address exists, whether it
  // still needs confirming, and which token to carry into the mail.
  //
  // Where that lands changed in #2201. It used to be true that none of it
  // ever reached a response body; now the join endpoint's status block is
  // built from this row on purpose, and /resend still answers every branch
  // with the same bytes. The row is the same either way — which caller
  // reads it is what differs.
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const pending = await getSignupByEmail(pool, 'a@example.com');
  assert.equal(pending.confirmed_at, null);
  assert.ok(pending.more_token, 'the join mints the token');

  const code = await issueVerificationCode(pool, 'a@example.com');
  await confirmSignupByCode(pool, 'a@example.com', code);

  const confirmed = await getSignupByEmail(pool, 'a@example.com');
  assert.ok(confirmed.confirmed_at, 'a confirmed row is distinguishable to the CALLER');
  assert.equal(confirmed.more_token, pending.more_token);
});

test('getSignupByEmail selects the whole status tuple, in one query', async () => {
  // signupStatus() reads submitted_at, confirmed_at, released_at and
  // linked_user_id. Before #2201 this query selected two of the four, so
  // the join branch that now answers a returning reader would have had to
  // either issue a second read or report a state built from nulls — and a
  // panel that says "on the list since" with no date is the bug the whole
  // change exists to remove.
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });

  const row = await getSignupByEmail(pool, 'a@example.com');
  for (const column of [
    'id', 'email', 'submitted_at', 'confirmed_at',
    'released_at', 'linked_user_id', 'more_token',
  ]) {
    assert.ok(Object.hasOwn(row, column), `getSignupByEmail must select ${column}`);
  }
  assert.ok(row.submitted_at, 'a joined row knows when it joined');
});

// ─── 5. The reuse window: a live code is left alone, not replaced ─────

test('a code minted seconds ago is reusable, so a fresh ask leaves it alone', async () => {
  // The whole point of the window. issueVerificationCode DELETEs every
  // unconsumed code before it INSERTs, and the mail throttle only decides
  // afterwards — so without this predicate, a second ask inside the minute
  // destroyed the code already sitting in the inbox AND delivered nothing
  // to replace it, because waitlist_code allows one send per minute.
  const { state, pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  await issueVerificationCode(pool, 'a@example.com');

  assert.equal(await hasReusableCode(pool, 'a@example.com'), true);
  assert.equal(state.codes.length, 1);
});

test('a code older than the window is not reusable', async () => {
  // Past the gap the throttle will allow a send, so there is a fresh code
  // to be had and no reason to keep serving the old one.
  const { state, pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  await issueVerificationCode(pool, 'a@example.com');

  state.codes[0].created_at = new Date(
    Date.now() - (CODE_REUSE_WINDOW_SECONDS + 5) * 1000
  );
  assert.equal(await hasReusableCode(pool, 'a@example.com'), false);
});

test('a code somebody has guessed at is not reusable', async () => {
  // attempts > 0 means they are typing a code they HAVE and getting it
  // wrong, so "the one in your inbox still works" is the wrong answer:
  // minting a fresh one is what they actually asked for.
  const { state, pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  await issueVerificationCode(pool, 'a@example.com');

  await confirmSignupByCode(pool, 'a@example.com', '999999');
  assert.equal(state.codes[0].attempts, 1);
  assert.equal(await hasReusableCode(pool, 'a@example.com'), false);
});

test('an expired or consumed code is not reusable', async () => {
  const { state, pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await issueVerificationCode(pool, 'a@example.com');

  // Expired: inside the 60s window by created_at, but dead anyway. Both
  // halves have to hold, and the window is the weaker of the two.
  state.codes[0].expires_at = new Date(Date.now() - 1000);
  assert.equal(await hasReusableCode(pool, 'a@example.com'), false);

  // Consumed: they already used it, so there is nothing live to protect.
  state.codes[0].expires_at = new Date(Date.now() + 15 * 60 * 1000);
  await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(state.codes[0].consumed_at);
  assert.equal(await hasReusableCode(pool, 'a@example.com'), false);
});

test('an address with no code at all is not reusable', async () => {
  // The first ask of all must mint, or nobody ever gets a code.
  const { pool } = fixture();
  await joinWaitlist(pool, { email: 'a@example.com' });
  assert.equal(await hasReusableCode(pool, 'a@example.com'), false);
});

test('hasReusableCode refuses a non-address without touching the database', async () => {
  // Same contract as getSignupByEmail: the mock throws on an unhandled
  // query, so reaching the pool at all would fail here.
  const { pool } = fixture();
  assert.equal(await hasReusableCode(pool, 'not-an-email'), false);
  assert.equal(await hasReusableCode(pool, null), false);
});

test('the reuse window mirrors the account OTP flow', async () => {
  // Not a coincidence and not a number to retune on its own:
  // services/email-signup.js solved this exact bug class for account OTPs
  // first, and the two windows describing the same "the mail is already
  // out" state should describe it identically.
  //
  // email-signup.js keeps its constant module-private, so read it from the
  // source rather than widening that module's surface for a test.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'email-signup.js'),
    'utf8'
  );
  const match = source.match(/const OTP_REUSE_WINDOW_SECONDS = (\d+);/);
  assert.ok(match, 'email-signup.js still declares the OTP reuse window');
  assert.equal(CODE_REUSE_WINDOW_SECONDS, Number(match[1]));
});
