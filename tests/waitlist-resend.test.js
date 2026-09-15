// POST /api/public/waitlist/resend — the non-enumeration contract.
//
// The six-digit confirmation code expires fifteen minutes after a join, and
// until this endpoint there was no way to ask for another one: a returning
// visitor on a new device could only submit the join form again, which is
// idempotent, so it minted nothing, sent nothing, and told them a code was
// on its way regardless.
//
// The property that matters most here is NOT that a code goes out. It is
// that the answer is the same one in every case. This endpoint is public and
// unauthenticated, and it takes an email address, so any difference between
// its branches — a status code, a word, a timing hint carried in the body —
// turns it into a membership oracle for the waitlist. Whether an address is
// already confirmed is disclosed in the MAIL instead, which only the address
// itself receives.
//
// #1538 widened what the mail is FOR without touching any of that. A
// confirmed address used to get no code at all, which made "check my
// status" impossible from a device that had never joined: the only thing
// this endpoint would send it was a stage-2 survey link. Every branch now
// mints, and the four bodies are still one frozen object.
//
// Harness style follows tests/waitlist-rate-limit.test.js: swap src/db/pool
// for an in-memory mock, drop the rate-limits and public-api modules from
// require.cache so each test gets fresh limiter stores, mount
// publicApiRoutes on a throwaway Express app, and talk to it over HTTP.
//
// Run with: node --test tests/waitlist-resend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const TOKEN = 'a'.repeat(48);

// The four branches, one address each, so a single mock can answer all of
// them and the bodies can be compared against each other.
const PENDING = 'pending@example.invalid';
const CONFIRMED = 'confirmed@example.invalid';
const STRANGER = 'stranger@example.invalid';
const BROKEN = 'broken@example.invalid';

const JOINED_AT = new Date('2026-03-14T10:00:00.000Z');

// PENDING and CONFIRMED are already on the list, so joinWaitlist's
// ON CONFLICT insert writes nothing for them; STRANGER and BROKEN are not.
const ON_THE_LIST = new Set([PENDING, CONFIRMED]);

// `log` collects every statement so a test can assert on what did NOT run —
// which is the only way to see the reuse window, whose whole effect is an
// absence. `reusableCode` makes hasReusableCode answer true.
function makeMockPool({ log = [], reusableCode = false } = {}) {
  return {
    log,
    async query(sql, params) {
      log.push(sql.replace(/\s+/g, ' ').trim());
      // hasReusableCode's probe. Must be tested BEFORE the broader
      // waitlist_verification_codes branch below, whose pattern this
      // statement also matches.
      if (/SELECT 1[\s\S]*FROM waitlist_verification_codes/.test(sql)) {
        return { rows: reusableCode ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT id, email, submitted_at, confirmed_at[\s\S]*FROM waitlist_signups/.test(sql)) {
        const email = params[0];
        const base = {
          email, submitted_at: JOINED_AT, released_at: null,
          linked_user_id: null, more_token: TOKEN,
        };
        if (email === PENDING) return { rows: [{ id: 1, ...base, confirmed_at: null }] };
        if (email === CONFIRMED) {
          return { rows: [{ id: 2, ...base, confirmed_at: new Date('2026-03-14T10:05:00.000Z') }] };
        }
        if (email === BROKEN) throw new Error('pool is on fire');
        return { rows: [] };
      }
      // issueVerificationCode's delete and write.
      if (/waitlist_verification_codes/.test(sql)) return { rows: [{ id: 1 }] };
      // joinWaitlist's ON CONFLICT DO NOTHING insert. No returned row is a
      // RE-join: the row was already there, so nothing was written.
      if (/INSERT INTO waitlist_signups/.test(sql)) {
        return ON_THE_LIST.has(params[0])
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ submitted_at: JOINED_AT }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function join(base, email, headers = {}) {
  return fetch(`${base}/api/public/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email }),
  });
}

async function withPublicApi(fn, extraConfig = {}, poolOptions = {}) {
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  const mockPool = makeMockPool(poolOptions);
  require.cache[poolPath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolPath, filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  delete require.cache[rateLimitsPath];
  delete require.cache[publicApiPath];
  let server;
  try {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test', ...extraConfig }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`, mockPool);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }
}

function resend(base, email) {
  return fetch(`${base}/api/public/waitlist/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

test('every branch answers with the same status and the same bytes', async () => {
  // SCOPE: this is /resend only, and deliberately so. POST /api/public/waitlist
  // stopped keeping this property in #2201 — it now branches three ways and
  // says which one ran, because a returning reader was being told a code was
  // coming when nothing was. /resend kept the frozen body: unlike the join, it
  // has no returning-reader problem to solve, and it is the endpoint an
  // attacker would reach for, since it takes an address and needs no survey
  // answers. The two endpoints answering differently is the design, not drift.
  await withPublicApi(async (base) => {
    const seen = [];
    for (const email of [PENDING, CONFIRMED, STRANGER, BROKEN]) {
      const res = await resend(base, email);
      seen.push({ status: res.status, body: await res.text() });
    }
    // Compared as raw text, not as parsed objects: key ORDER is observable
    // over the wire too, and a body that merely deep-equals another can
    // still be told apart by anyone counting bytes.
    for (const answer of seen) {
      assert.equal(answer.status, seen[0].status);
      assert.equal(answer.body, seen[0].body);
    }
    assert.equal(seen[0].status, 200);
    const body = JSON.parse(seen[0].body);
    assert.equal(body.ok, true);
    assert.equal(body.cooldown_seconds, 60);
    assert.match(body.message, /six-digit code is on its way/i);
    // It must not claim the address "still needs confirming" (#1538): a
    // confirmed address is now a first-class caller here, so that clause
    // would be false for the very branch check-my-status runs, and a false
    // clause in a shared body is a hint about which branch answered.
    assert.doesNotMatch(body.message, /needs confirming/i);
    // The words must not resolve the question either. "If that address" is
    // load-bearing copy, not hedging.
    assert.match(body.message, /if that address/i);
  });
});

test('a database failure is still a 200, not a 500', async () => {
  // A 500 for one address and a 200 for another is the oracle again, and it
  // is the easiest one to reintroduce: the natural shape of the handler is
  // to let the read throw.
  await withPublicApi(async (base) => {
    const res = await resend(base, BROKEN);
    assert.equal(res.status, 200);
  });
});

test('a malformed address is refused before any lookup happens', async () => {
  // The one branch that DOES answer differently, and it may: "that is not
  // an email address" is a statement about the input, not about the list.
  await withPublicApi(async (base) => {
    for (const bad of ['', 'not-an-email', 'a@', '   ']) {
      const res = await resend(base, bad);
      assert.equal(res.status, 422, `expected 422 for ${JSON.stringify(bad)}`);
    }
  });
});

test('both a pending and a confirmed address are mailed a fresh code (#1538)', async () => {
  // The mail is the ONLY channel that distinguishes the two, and it goes to
  // the address itself, so it discloses nothing to a third party.
  //
  // The confirmed branch is the one #1538 fixed. It used to return before
  // minting anything and mail a stage-2 survey link instead, which is
  // backwards: anyone asking to read their status is by definition already
  // confirmed, so the branch that most needs a code was the only one that
  // never got one.
  const seen = [];
  await withPublicApi(async (base) => {
    await resend(base, PENDING);
    await resend(base, CONFIRMED);
    await resend(base, STRANGER);
  }, { mailTransport: { send: async (m) => { seen.push(m); } } });

  assert.equal(seen.length, 2, 'an address that is not on the list is mailed nothing');

  // Unconfirmed: a code plus the one-click confirm link, unchanged.
  assert.equal(seen[0].kind, 'waitlist_code');
  assert.equal(seen[0].confirmed, false);
  assert.match(seen[0].code, /^[0-9]{6}$/);
  assert.match(seen[0].confirmUrl, /\/api\/public\/waitlist\/confirm\/a{48}$/);

  // Confirmed: a code as well, flagged so the template picks the
  // status-code wording, and NO confirm link — there is nothing left to
  // confirm, and a capability token in a mail nobody asked for is a
  // capability handed to whoever the mailbox forwards to.
  assert.equal(seen[1].kind, 'waitlist_code');
  assert.equal(seen[1].confirmed, true);
  assert.match(seen[1].code, /^[0-9]{6}$/);
  assert.equal(seen[1].confirmUrl, null);
  // The status URL is a query spelling, never a fragment: the link
  // rewriters mail providers apply drop everything after the `#` (#1545).
  assert.match(seen[1].statusUrl, /\/\?status=1$/);
  assert.doesNotMatch(seen[1].statusUrl, /#/);

  // And the two codes are different values, because each call mints its
  // own and deletes any predecessor.
  assert.notEqual(seen[0].code, seen[1].code);
});

test('a confirmed address falls back to the survey link only when minting fails', async () => {
  // The degradation, kept from the old behaviour: if the code cannot be
  // written we still send something the address can act on rather than
  // going silent. It is the fallback now, not the rule.
  const seen = [];
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  const base = makeMockPool();
  const brokenMint = {
    async query(sql, params) {
      if (/INSERT INTO waitlist_verification_codes/.test(sql)) {
        throw new Error('codes table is on fire');
      }
      return base.query(sql, params);
    },
  };
  require.cache[poolPath] = {
    exports: { getPool: () => brokenMint },
    loaded: true, id: poolPath, filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  delete require.cache[rateLimitsPath];
  delete require.cache[publicApiPath];
  let server;
  try {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({
      databaseUrl: 'postgres://fake/fake',
      env: 'test',
      mailTransport: { send: async (m) => { seen.push(m); } },
    }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await resend(origin, CONFIRMED)).status, 200);
    assert.equal((await resend(origin, PENDING)).status, 200);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }

  assert.equal(seen.length, 1, 'only the confirmed branch has a fallback to send');
  assert.equal(seen[0].code, null);
  assert.match(seen[0].statusUrl, /#more\/a{48}$/);
});

test('the resend limiter is keyed per address, not shared across them', async () => {
  // Six requests for one address exhaust its bucket; a seventh for a
  // different address must not be caught by it. The per-IP limiter is
  // deliberately looser than 6, or this test would fail on that instead.
  await withPublicApi(async (base) => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await resend(base, PENDING)).status);
    }
    assert.equal(statuses[0], 200);
    assert.equal(statuses[5], 429, 'the sixth request for one address is throttled');
    assert.equal((await resend(base, CONFIRMED)).status, 200);
  });
});

test('an unconfirmed re-join mails one fresh code and says so (#2201)', async () => {
  // The bug behind the whole feature. joinWaitlist is idempotent by email,
  // so a second submit wrote nothing, minted nothing and mailed nothing —
  // while the screen said "we sent a six-digit code to you@..." on any 200.
  //
  // This test used to assert that the RESPONSE was unchanged, on the grounds
  // that the join must not disclose membership either. That is the decision
  // #2201 reversed: the address is on the list and still needs confirming,
  // so the honest answer names both facts and hands the client a status
  // block, and the client shows the code step with the right words above it.
  const seen = [];
  await withPublicApi(async (base) => {
    const res = await join(base, PENDING);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.message, /already on the waitlist/i);
    assert.equal(body.status.confirmed, false, 'this address still needs confirming');
    assert.ok(body.status.joined_at, 'and the panel can say since when');
    // A re-join still carries no stage-2 token: that dereferences to an
    // address, its survey answers and its invite list, so handing one to
    // whoever typed the address is a capability leak. Membership disclosure
    // was decided on; this was not part of it.
    assert.equal(body.more_token, null);
  }, { mailTransport: { send: async (m) => { seen.push(m); } } });

  assert.equal(seen.length, 1, 'exactly one mail, and it is not a second welcome');
  assert.equal(seen[0].kind, 'waitlist_code');
  assert.match(seen[0].code, /^[0-9]{6}$/);
});

test('a confirmed re-join mails nothing and lands on the settled panel (#2201)', async () => {
  // Case 3, and the reason the branch reads the row BEFORE deciding. There
  // is nothing left for this person to do, so there is nothing to mint,
  // nothing to delete and nothing to mail — the answer is a status block,
  // which is what puts the client on the settled panel instead of in front
  // of a code field waiting for a mail that is not coming.
  const seen = [];
  await withPublicApi(async (base, pool) => {
    const res = await join(base, CONFIRMED);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.message, /already on the waitlist, and this address is confirmed/i);
    assert.equal(body.status.confirmed, true);
    assert.equal(body.more_token, null, 'no capability token on a re-join, confirmed or not');

    // Nothing minted and nothing deleted: the old code routed every re-join
    // through resendConfirmation, which DELETEd this reader's live code to
    // mint one it then mailed as a status code nobody was waiting for.
    const touched = pool.log.filter((sql) => /waitlist_verification_codes/.test(sql));
    assert.deepEqual(touched, [], 'a confirmed re-join must not touch the code table');
  }, { mailTransport: { send: async (m) => { seen.push(m); } } });

  assert.deepEqual(seen, [], 'and mails nothing at all');
});

test('a re-join inside the reuse window neither mints nor mails', async () => {
  // Case 2 goes through resendConfirmation, which leaves a code minted
  // seconds ago alone. Two submits a few seconds apart is the ordinary
  // shape of an impatient person, and without the window the second one
  // DELETEd the code already in their inbox and then delivered nothing,
  // because waitlist_code allows one send a minute per address.
  const seen = [];
  await withPublicApi(async (base, pool) => {
    assert.equal((await join(base, PENDING)).status, 200);

    const wrote = pool.log.filter((sql) => /^(INSERT INTO|DELETE FROM) waitlist_verification_codes/.test(sql));
    assert.deepEqual(wrote, [], 'the live code is left exactly where it is');
  }, { mailTransport: { send: async (m) => { seen.push(m); } } }, { reusableCode: true });

  assert.deepEqual(seen, [], 'and no mail claims a fresh one was sent');
});

test('a suppressed send leaves the previously delivered code alive', async () => {
  // Same guarantee from /resend's side, and stated the other way round: the
  // point is not that the second ask does less, it is that the code the
  // first ask actually delivered still works. Deleting it is what made the
  // mail in the inbox a dead end.
  const seen = [];
  await withPublicApi(async (base, pool) => {
    const res = await resend(base, PENDING);
    // The frozen body, unchanged: the reuse window is invisible from
    // outside, which is also what keeps it from becoming an oracle.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.message, /six-digit code is on its way/i);

    assert.deepEqual(
      pool.log.filter((sql) => /^DELETE FROM waitlist_verification_codes/.test(sql)),
      [],
      'nothing deletes the code that was delivered'
    );
    assert.deepEqual(
      pool.log.filter((sql) => /^INSERT INTO waitlist_verification_codes/.test(sql)),
      [],
      'and nothing replaces it with one that was not'
    );
  }, { mailTransport: { send: async (m) => { seen.push(m); } } }, { reusableCode: true });

  assert.deepEqual(seen, [], 'the mail throttle would have dropped this send anyway');
});

test('an integrator-keyed re-join gets the pre-#2201 body, with no status block', async () => {
  // The bound on the oracle. A first-party join comes from a browser
  // through 5 requests per 15 minutes per IP, which is a rate a person
  // reaches and a harvester does not. An integrator key re-keys that budget
  // to a label with a much larger ceiling, so the same disclosure through
  // it would be bulk membership testing — and an integrator proxies other
  // people's addresses, so it has no returning reader of its own to serve.
  await withPublicApi(async (base) => {
    const keyed = { 'X-Waitlist-Client-Key': 's3cret' };

    const confirmed = await (await join(base, CONFIRMED, keyed)).json();
    assert.equal(Object.hasOwn(confirmed, 'status'), false, 'case 3 discloses nothing');

    const pending = await (await join(base, PENDING, keyed)).json();
    assert.equal(Object.hasOwn(pending, 'status'), false, 'nor does case 2');

    const fresh = await (await join(base, STRANGER, keyed)).json();
    assert.equal(Object.hasOwn(fresh, 'status'), false, 'nor does case 1');
    assert.match(fresh.more_token, /^[0-9a-f]{48}$/, 'but the first join still returns its token');

    // Same request without the key: the status block is back. Without this
    // half, a broken key parser would pass the three assertions above for
    // the wrong reason.
    const unkeyed = await (await join(base, CONFIRMED)).json();
    assert.equal(unkeyed.status.confirmed, true);
  }, {
    waitlistIntegrationKeys: 'acme:s3cret',
    mailTransport: { send: async () => {} },
  });
});
