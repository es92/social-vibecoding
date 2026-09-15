// POST /api/public/waitlist/confirm — the status block it hands back (#1538).
//
// "Check my status" has no new endpoint and no new screen. Anyone can enter
// their waitlist email from any device, get a six-digit code by mail, and
// type it here; the reply carries where that row actually stands. The read
// rides on the CONFIRM route because the code is the authentication: only
// the mailbox that owns the address could have received it.
//
// Three properties are guarded here, and the first two are the ones that
// keep this from becoming a membership oracle:
//
//   1. Every failure is the SAME 422 — wrong code, expired code, an
//      address that never joined, a malformed body. Nothing about the
//      response distinguishes "no such address" from "wrong digits".
//   2. Nothing is disclosed WITHOUT a correct code. A caller who cannot
//      read the mailbox gets the identical refusal for every address.
//   3. A correct code answers with signupStatus() — the same helper
//      /more/:token derives from, so the two surfaces can never describe
//      one row differently.
//
// It also pins what the block deliberately does NOT contain: a queue
// position. services/waitlist-signals.js computes no rank on purpose, and
// a number that can go backwards is a promise this platform has not made.
//
// Harness style follows tests/waitlist-status.test.js: swap src/db/pool for
// an in-memory mock, drop the rate-limits and public-api modules from
// require.cache so limiter stores start empty, mount publicApiRoutes on a
// throwaway Express app and talk real HTTP.
//
// Run with: node --test tests/waitlist-status-code.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const TOKEN = 'a'.repeat(48);
const RIGHT = '424242';
const WRONG = '999999';

const JOINED = new Date('2026-01-02T03:04:05.000Z');
const CONFIRMED_AT = new Date('2026-01-03T03:04:05.000Z');
const RELEASED_AT = new Date('2026-01-09T03:04:05.000Z');

// One address per state, so a single mock answers all of them and the
// refusals can be compared against each other byte for byte.
const PENDING = 'pending@example.invalid';
const CONFIRMED = 'confirmed@example.invalid';
const ADMITTED = 'admitted@example.invalid';
const LINKED = 'linked@example.invalid';
const STRANGER = 'stranger@example.invalid';

const ROWS = {
  [PENDING]: {
    id: 1, email: PENDING, submitted_at: JOINED,
    confirmed_at: null, released_at: null, linked_user_id: null, more_token: TOKEN,
  },
  [CONFIRMED]: {
    id: 2, email: CONFIRMED, submitted_at: JOINED,
    confirmed_at: CONFIRMED_AT, released_at: null, linked_user_id: null, more_token: TOKEN,
  },
  [ADMITTED]: {
    id: 3, email: ADMITTED, submitted_at: JOINED,
    confirmed_at: CONFIRMED_AT, released_at: RELEASED_AT, linked_user_id: null, more_token: TOKEN,
  },
  [LINKED]: {
    id: 4, email: LINKED, submitted_at: JOINED,
    confirmed_at: CONFIRMED_AT, released_at: RELEASED_AT, linked_user_id: 900001, more_token: TOKEN,
  },
};

// The mock stands in for the whole confirmSignupByCode path: it answers the
// live-code SELECT, accepts RIGHT and rejects everything else, and returns
// the widened RETURNING tuple from the UPDATE. A pending row is confirmed by
// the UPDATE itself (COALESCE), exactly as the column would be.
function makeMockPool() {
  return {
    async query(sql, params) {
      if (/FROM waitlist_verification_codes/.test(sql)) {
        // A live code exists for every address the fixture knows about, and
        // for none of the others.
        if (!ROWS[params[0]]) return { rows: [] };
        return {
          rows: [{
            id: 10,
            // bcrypt.compare against a non-hash returns false rather than
            // throwing, which is what makes WRONG fail without a second
            // fixture. RIGHT is matched by the hash below.
            code_hash: RIGHT_HASH,
            attempts: 0,
            expires_at: new Date(Date.now() + 60_000),
          }],
        };
      }
      if (/UPDATE waitlist_verification_codes/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE waitlist_signups[\s\S]*RETURNING/.test(sql)) {
        const row = ROWS[params[0]];
        if (!row) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{ ...row, confirmed_at: row.confirmed_at || new Date() }],
        };
      }
      // The join path, for the re-join comparison below. Every address the
      // fixture knows about is already on the list, so the ON CONFLICT
      // insert returns no row and getSignupByEmail answers with the same
      // tuple the confirm route's UPDATE returns.
      if (/INSERT INTO waitlist_signups/.test(sql)) {
        return ROWS[params[0]]
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ submitted_at: JOINED }] };
      }
      if (/SELECT id, email, submitted_at, confirmed_at[\s\S]*FROM waitlist_signups/.test(sql)) {
        const row = ROWS[params[0]];
        return { rows: row ? [row] : [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

// Hashed once at load: bcrypt at cost 10 is deliberately slow, and every
// request in this file compares against the same digits.
const RIGHT_HASH = require('bcrypt').hashSync(RIGHT, 10);

async function withPublicApi(fn, extraConfig = {}) {
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => makeMockPool() },
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
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }
}

function confirm(base, email, code) {
  return fetch(`${base}/api/public/waitlist/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
}

// ─── The answer a correct code earns ─────────────────────────────────

test('a confirmed row reads back as confirmed, not as a fresh confirmation', async () => {
  await withPublicApi(async (base) => {
    const res = await confirm(base, CONFIRMED, RIGHT);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status.state, 'confirmed');
    assert.equal(body.status.confirmed, true);
    assert.equal(body.status.admitted, false);
    assert.equal(body.status.has_account, false);
    // The date the panel offers in place of a queue position.
    assert.equal(body.status.joined_at, JOINED.toISOString());
    // Unchanged: the code read did not restamp the row.
    assert.equal(body.status.confirmed_at, CONFIRMED_AT.toISOString());
  });
});

test('a confirmed re-join reads back the same row, unmoved (#2201)', async () => {
  // The join endpoint now answers a confirmed address with a status block
  // too, and it has to be the SAME block: one helper, signupStatus(), or
  // the two surfaces start describing one row differently.
  //
  // What this really pins is that case 3 is a pure read. It returns before
  // anything mints, and confirmSignupByCode's UPDATE uses COALESCE so that
  // the FIRST confirmation wins — but case 3 never reaches that UPDATE at
  // all, so a re-join cannot restamp confirmed_at even by accident, and the
  // panel keeps saying the date it said before.
  await withPublicApi(async (base) => {
    const viaCode = await (await confirm(base, CONFIRMED, RIGHT)).json();
    const viaJoin = await (await fetch(`${base}/api/public/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CONFIRMED }),
    })).json();

    assert.equal(viaJoin.status.confirmed, true);
    assert.equal(viaJoin.status.confirmed_at, CONFIRMED_AT.toISOString(),
      'a re-join must not restamp the row');
    assert.equal(viaJoin.status.joined_at, JOINED.toISOString());
    assert.deepEqual(viaJoin.status, viaCode.status, 'one row, one description');
    // And no capability rides along with it.
    assert.equal(viaJoin.more_token, null);
  });
});

test('an admitted row says so, and a redeemed one says which way to go', async () => {
  await withPublicApi(async (base) => {
    const admitted = await (await confirm(base, ADMITTED, RIGHT)).json();
    assert.equal(admitted.status.state, 'admitted');
    assert.equal(admitted.status.admitted, true);
    assert.equal(admitted.status.admitted_at, RELEASED_AT.toISOString());
    // Admitted but never redeemed: the screen offers "Create my account".
    assert.equal(admitted.status.has_account, false);

    const linked = await (await confirm(base, LINKED, RIGHT)).json();
    assert.equal(linked.status.state, 'admitted');
    // Redeemed already: the screen offers "Sign in" instead. Having been
    // admitted and having an account are different questions.
    assert.equal(linked.status.has_account, true);
  });
});

test('a pending row confirms on this call and reads back as confirmed', async () => {
  // The original errand of this endpoint, unchanged by #1538: a code from a
  // join mail still confirms. The status block just describes the result.
  await withPublicApi(async (base) => {
    const body = await (await confirm(base, PENDING, RIGHT)).json();
    assert.equal(body.status.state, 'confirmed');
    assert.equal(body.status.confirmed, true);
    assert.ok(body.status.confirmed_at, 'the UPDATE stamped it');
  });
});

test('admitted is answered at the top level too, and the two spellings agree', async () => {
  await withPublicApi(async (base) => {
    for (const [email, expected] of [[CONFIRMED, false], [ADMITTED, true], [LINKED, true]]) {
      const body = await (await confirm(base, email, RIGHT)).json();
      assert.equal(body.admitted, expected, `top-level admitted wrong for ${email}`);
      assert.equal(body.admitted, body.status.admitted, 'the two spellings disagree');
    }
  });
});

test('the block carries no queue position, and no rank under any name', async () => {
  // Deliberate: waitlist-signals.js computes no score, so any number here
  // would be invented. A position is a promise, and it can go backwards.
  await withPublicApi(async (base) => {
    const body = await (await confirm(base, CONFIRMED, RIGHT)).json();
    const keys = Object.keys(body.status).sort();
    assert.deepEqual(keys, [
      'admitted', 'admitted_at', 'confirmed', 'confirmed_at',
      'has_account', 'joined_at', 'state',
    ]);
    const text = JSON.stringify(body);
    for (const word of ['position', 'rank', 'place_in', 'ahead_of', 'queue_length']) {
      assert.doesNotMatch(text, new RegExp(word, 'i'), `${word} leaked into the reply`);
    }
  });
});

test('the stage-2 token still rides along, so the survey stays reachable', async () => {
  await withPublicApi(async (base) => {
    const body = await (await confirm(base, CONFIRMED, RIGHT)).json();
    assert.equal(body.more_token, TOKEN);
  });
});

// ─── Nothing at all without a correct code ───────────────────────────

test('every failure is the same 422 with the same bytes', async () => {
  await withPublicApi(async (base) => {
    const seen = [];
    for (const [email, code] of [
      [CONFIRMED, WRONG],   // on the list, wrong digits
      [ADMITTED, WRONG],    // admitted, wrong digits
      [PENDING, WRONG],     // pending, wrong digits
      [STRANGER, WRONG],    // never joined
      [STRANGER, RIGHT],    // never joined, and the digits that work elsewhere
    ]) {
      const res = await confirm(base, email, code);
      seen.push({ status: res.status, body: await res.text() });
    }
    // Compared as raw text, not as parsed objects: key order is observable
    // over the wire too.
    for (const answer of seen) {
      assert.equal(answer.status, 422);
      assert.equal(answer.body, seen[0].body);
    }
    // And the refusal says nothing about the address.
    const body = JSON.parse(seen[0].body);
    assert.doesNotMatch(body.error, /waitlist|not on|unknown address|no such/i);
  });
});

test('a malformed body is refused before any lookup, and says nothing either', async () => {
  await withPublicApi(async (base) => {
    for (const [email, code] of [
      ['', RIGHT], ['not-an-email', RIGHT],
      [CONFIRMED, ''], [CONFIRMED, '12345'], [CONFIRMED, 'abcdef'], [CONFIRMED, null],
    ]) {
      const res = await confirm(base, email, code);
      assert.equal(res.status, 422, `expected 422 for ${JSON.stringify([email, code])}`);
      const body = await res.json();
      assert.equal(body.status, undefined, 'no status block without a correct code');
      assert.equal(body.more_token, undefined, 'no capability token either');
    }
  });
});

test('a refusal carries no status block and no token', async () => {
  // The one thing that would undo the whole non-enumeration contract: a
  // partial answer on the failure path.
  await withPublicApi(async (base) => {
    const body = await (await confirm(base, ADMITTED, WRONG)).json();
    assert.equal(body.ok, undefined);
    assert.equal(body.status, undefined);
    assert.equal(body.admitted, undefined);
    assert.equal(body.more_token, undefined);
    assert.ok(body.error, 'there is an error message, and it is the shared one');
  });
});
