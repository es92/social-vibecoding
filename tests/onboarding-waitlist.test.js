// src/services/waitlist.js — the email-keyed platform waitlist
// (onboarding flow alignment). The waitlist is keyed by EMAIL, not by
// user: anyone can join from the public landing page without an account,
// and an admin can release an email before its owner registers. Release
// means "platform access is granted the moment a matching account
// exists" — immediately when one already does, or at account creation
// via linkUserByEmail.
//
// Contracts guarded here:
//
//   1. normalizeEmail is the single sanitizer: trims, lowercases, and
//      rejects non-emails so a garbage POST can never mint a row.
//   2. joinWaitlist is idempotent by email: re-joining is a silent no-op
//      at the DATABASE level, keeping the original submitted_at. What it
//      reports about that changed in #2201 — the public endpoint now
//      answers a re-join differently on purpose — but `created` and the
//      row count are unaffected, and the capability is not: a re-join
//      still returns a null moreToken, which is the guard below.
//   3. linkUserByEmail points the email's row at the new account, and a
//      row that was ALREADY released grants has_platform_access on the
//      spot (the doc's "released off the waitlist — create an account if
//      you haven't already" arrow). An unreleased row grants nothing.
//   4. releaseWaitlistSignup grants access to a linked account, resolves
//      an unlinked account by email (backfilling the link), and for a
//      not-yet-registered email just sets released_at — the grant then
//      happens at account creation via contract 3.
//   5. grantPlatformAccess is idempotent (the original granted_at wins).
//
// Service-level tests against a stateful in-memory mock pool — no live
// DB.
//
// Run with: node --test tests/onboarding-waitlist.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmail,
  joinWaitlist,
  getSignupByMoreToken,
  mergeMoreAnswers,
  setVerifiedHandle,
  grantPlatformAccess,
  linkUserByEmail,
  releaseWaitlistSignup,
} = require('../src/services/waitlist');

// ─── Stateful mock pool ───────────────────────────────────────────────
//
// Simulates just the rows/statements waitlist.js touches:
//   state.signups — Map(email -> { id, email, released_at, linked_user_id })
//   state.users   — Map(id -> { id, email, has_platform_access, platform_access_granted_at })

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeState() {
  return { signups: new Map(), users: new Map(), nextSignupId: 1 };
}

function makePool(state) {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.startsWith('INSERT INTO waitlist_signups')) {
      const [email, , answers, moreToken] = params;
      // ON CONFLICT DO NOTHING ... RETURNING returns NO ROW on a
      // conflict, which is how joinWaitlist tells a re-join from a first
      // join. Returning rowCount alone would make every join look fresh.
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
      return { rowCount: 1, rows: [{ submitted_at: submittedAt }] };
    }

    if (sql.includes('WHERE more_token = $1')) {
      const [token] = params;
      const s = [...state.signups.values()].find((r) => r.more_token === token);
      return { rows: s ? [{ id: s.id, email: s.email, answers: s.answers }] : [] };
    }

    if (sql.includes('SET answers = $1 WHERE id = $2')) {
      const [answers, id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      if (s) s.answers = JSON.parse(answers);
      return { rowCount: s ? 1 : 0, rows: [] };
    }

    if (sql.includes('SET has_platform_access = TRUE')) {
      const [userId] = params;
      const u = state.users.get(userId);
      if (u && !u.has_platform_access) {
        u.has_platform_access = true;
        u.platform_access_granted_at = u.platform_access_granted_at || new Date();
      }
      return { rowCount: u ? 1 : 0, rows: [] };
    }

    if (sql.includes('SET linked_user_id = $1 WHERE email = $2')) {
      const [userId, email] = params;
      const s = state.signups.get(email);
      if (!s) return { rowCount: 0, rows: [] };
      s.linked_user_id = userId;
      return { rowCount: 1, rows: [{ released_at: s.released_at }] };
    }

    if (sql.includes('SET released_at = COALESCE(w.released_at, NOW()) WHERE w.id = $1')) {
      const [id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      if (!s) return { rowCount: 0, rows: [] };
      const newlyReleased = s.released_at == null;
      s.released_at = s.released_at || new Date();
      return {
        rowCount: 1,
        rows: [{
          id: s.id,
          email: s.email,
          released_at: s.released_at,
          linked_user_id: s.linked_user_id,
          newly_released: newlyReleased,
        }],
      };
    }

    if (sql.includes('SELECT id FROM users WHERE email = $1')) {
      const [email] = params;
      const u = [...state.users.values()].find((r) => r.email === email);
      return { rows: u ? [{ id: u.id }] : [] };
    }

    if (sql.includes('SET linked_user_id = $1 WHERE id = $2')) {
      const [userId, id] = params;
      const s = [...state.signups.values()].find((r) => r.id === id);
      if (s) s.linked_user_id = userId;
      return { rowCount: s ? 1 : 0, rows: [] };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

function addUser(state, { id, email = null, hasAccess = false }) {
  state.users.set(id, {
    id,
    email,
    has_platform_access: hasAccess,
    platform_access_granted_at: hasAccess ? new Date(0) : null,
  });
  return state.users.get(id);
}

// ─── 1. normalizeEmail ────────────────────────────────────────────────

test('normalizeEmail trims, lowercases, and validates', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(normalizeEmail('bob@site.io'), 'bob@site.io');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null); // no TLD dot
  assert.equal(normalizeEmail('has space@x.com'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@example.com`), null); // > 255
});

// ─── 2. joinWaitlist dedup ────────────────────────────────────────────

test('joining is idempotent by email', async () => {
  const state = makeState();
  const pool = makePool(state);

  const first = await joinWaitlist(pool, { email: 'new@example.com' });
  assert.equal(first.created, true);

  const again = await joinWaitlist(pool, { email: 'new@example.com' });
  assert.equal(again.created, false);
  assert.equal(state.signups.size, 1);
});

// ─── 2b. Two-stage survey (topochain waitlist port) ───────────────────

test('first join returns the stage-2 token; a re-join never does', async () => {
  const state = makeState();
  const pool = makePool(state);

  const first = await joinWaitlist(pool, {
    email: 'survey@example.com',
    answers: { made_url: 'https://example.com/thing' },
  });
  assert.match(first.moreToken, /^[a-f0-9]{48}$/);
  // Stage-1 answers land versioned. v3 is Andrea's 27 Aug 2026 review:
  // the discovery list was replaced and three fields were dropped, so a
  // row written after it does not mean the same thing as a v2 row.
  const row = state.signups.get('survey@example.com');
  assert.equal(row.answers._version, 3);
  assert.equal(row.answers.made_url, 'https://example.com/thing');

  // A second join with the same email must NOT hand out the capability —
  // anyone can type a stranger's address.
  //
  // This is the load-bearing guard now that the endpoint above it answers
  // a re-join differently (#2201). Disclosing "this address is on the
  // list, and confirmed" was a decision the app owner made; handing over
  // the token that dereferences to that address's survey answers, its
  // recorded email and its whole invite list was NOT part of it, and this
  // is the line between the two.
  const again = await joinWaitlist(pool, { email: 'survey@example.com' });
  assert.equal(again.moreToken, null);
  // Nor does the service hand back anything ELSE that widening the
  // response tempted: the shape a re-join returns carries no address, no
  // answers and no invite data for a caller to forward into a body.
  assert.deepEqual(Object.keys(again).sort(), ['created', 'moreToken', 'submittedAt']);
  assert.equal(again.submittedAt, null);
  for (const leak of ['email', 'answers', 'invite', 'more_token']) {
    assert.equal(Object.hasOwn(again, leak), false, `re-join must not return ${leak}`);
  }

  // The first join DOES report its own submitted_at, which is what lets
  // the endpoint build a status block without a second read.
  assert.ok(first.submittedAt instanceof Date);
});

test('getSignupByMoreToken resolves only well-formed, existing tokens', async () => {
  const state = makeState();
  const pool = makePool(state);
  const { moreToken } = await joinWaitlist(pool, { email: 't@example.com' });

  assert.ok(await getSignupByMoreToken(pool, moreToken));
  assert.equal(await getSignupByMoreToken(pool, 'f'.repeat(48)), null); // unknown
  assert.equal(await getSignupByMoreToken(pool, 'not-a-token'), null);  // malformed
  assert.equal(await getSignupByMoreToken(pool, null), null);
});

test('mergeMoreAnswers merges section-wise and keeps stage-1 answers', async () => {
  const state = makeState();
  const pool = makePool(state);
  const { moreToken } = await joinWaitlist(pool, {
    email: 'merge@example.com',
    answers: { made_url: 'https://a.example' },
  });

  await mergeMoreAnswers(pool, moreToken, {
    group: { name: 'Indie devs', size: '10-50' },
  });
  // A later visit fills a DIFFERENT section: group survives.
  await mergeMoreAnswers(pool, moreToken, {
    loss: { had: 'yes', product: 'Google Reader' },
  });

  const row = state.signups.get('merge@example.com');
  assert.equal(row.answers.made_url, 'https://a.example'); // stage 1 kept
  assert.equal(row.answers.group.name, 'Indie devs');
  assert.equal(row.answers.loss.product, 'Google Reader');

  // Unknown token → null, nothing written.
  assert.equal(await mergeMoreAnswers(pool, 'e'.repeat(48), { group: {} }), null);
});

test('setVerifiedHandle stores OAuth-verified handles apart from self-reported ones', async () => {
  const state = makeState();
  const pool = makePool(state);
  const { moreToken } = await joinWaitlist(pool, { email: 'v@example.com' });

  await mergeMoreAnswers(pool, moreToken, { handles: { discord: 'selfclaimed' } });
  await setVerifiedHandle(pool, moreToken, 'github', 'octocat');

  const row = state.signups.get('v@example.com');
  assert.equal(row.answers.verified.github, 'octocat');
  assert.equal(row.answers.handles.discord, 'selfclaimed');
});

// ─── 3. Account-creation linkage ──────────────────────────────────────

test('linking an UNRELEASED signup records the link but grants nothing', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'wait@example.com' });
  const user = addUser(state, { id: 10, email: 'wait@example.com' });

  await linkUserByEmail(pool, { userId: 10, email: 'Wait@Example.com' });

  assert.equal(state.signups.get('wait@example.com').linked_user_id, 10);
  assert.equal(user.has_platform_access, false);
});

test('linking a RELEASED signup grants platform access at account creation', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'released@example.com' });
  state.signups.get('released@example.com').released_at = new Date();
  const user = addUser(state, { id: 11, email: 'released@example.com' });

  await linkUserByEmail(pool, { userId: 11, email: 'released@example.com' });

  assert.equal(user.has_platform_access, true);
});

test('linkUserByEmail is a safe no-op for garbage input and unknown emails', async () => {
  const state = makeState();
  const pool = makePool(state);
  addUser(state, { id: 12, email: 'x@y.com' });

  await linkUserByEmail(pool, { userId: 12, email: 'not-an-email' });
  await linkUserByEmail(pool, { userId: 12, email: 'never-joined@example.com' });
  await linkUserByEmail(pool, { userId: null, email: 'x@y.com' });

  assert.equal(state.users.get(12).has_platform_access, false);
});

// ─── 4. Admin release ─────────────────────────────────────────────────

test('releasing an unknown signup id returns null', async () => {
  const pool = makePool(makeState());
  assert.equal(await releaseWaitlistSignup(pool, 999), null);
});

test('releasing a linked signup grants the linked account access', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'linked@example.com' });
  const user = addUser(state, { id: 20, email: 'linked@example.com' });
  await linkUserByEmail(pool, { userId: 20, email: 'linked@example.com' });

  const row = await releaseWaitlistSignup(pool, state.signups.get('linked@example.com').id);

  assert.ok(row.released_at);
  assert.equal(row.linked_user_id, 20);
  assert.equal(user.has_platform_access, true);
});

test('releasing an UNLINKED signup resolves the account by email and backfills the link', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'unlinked@example.com' });
  // The account predates linkage (or linkage was missed) — same email.
  const user = addUser(state, { id: 21, email: 'unlinked@example.com' });

  const row = await releaseWaitlistSignup(pool, state.signups.get('unlinked@example.com').id);

  assert.equal(row.linked_user_id, 21);
  assert.equal(state.signups.get('unlinked@example.com').linked_user_id, 21);
  assert.equal(user.has_platform_access, true);
});

test('releasing an email with NO account only marks released; the grant lands at signup', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'future@example.com' });

  const row = await releaseWaitlistSignup(pool, state.signups.get('future@example.com').id);
  assert.ok(row.released_at);
  assert.equal(row.linked_user_id, null);

  // ...the user registers later: linkage completes the release.
  const user = addUser(state, { id: 22, email: 'future@example.com' });
  await linkUserByEmail(pool, { userId: 22, email: 'future@example.com' });
  assert.equal(user.has_platform_access, true);
});

test('release is idempotent — the first released_at wins', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'twice@example.com' });
  const id = state.signups.get('twice@example.com').id;

  const first = await releaseWaitlistSignup(pool, id);
  const second = await releaseWaitlistSignup(pool, id);
  assert.equal(first.released_at.getTime(), second.released_at.getTime());
});

test('newly_released is true on the first release only — the "you\'re in" mail sends once', async () => {
  const state = makeState();
  const pool = makePool(state);
  await joinWaitlist(pool, { email: 'once@example.com' });
  const id = state.signups.get('once@example.com').id;

  const first = await releaseWaitlistSignup(pool, id);
  const second = await releaseWaitlistSignup(pool, id);
  assert.equal(first.newly_released, true);
  assert.equal(second.newly_released, false);
});

// ─── 5. grantPlatformAccess idempotence ───────────────────────────────

test('re-granting keeps the original granted_at', async () => {
  const state = makeState();
  const pool = makePool(state);
  const user = addUser(state, { id: 30, email: 'g@example.com' });

  await grantPlatformAccess(pool, 30);
  const firstGrant = user.platform_access_granted_at;
  await grantPlatformAccess(pool, 30);

  assert.equal(user.has_platform_access, true);
  assert.equal(user.platform_access_granted_at, firstGrant);
});
