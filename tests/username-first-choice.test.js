// First sign-in asks for a username instead of using the email (#2563).
//
// An account created by email sign-in was given its own address as
// `users.username` — the handle every other member sees on its messages,
// its profile address and the leaderboard. The contracts guarded here are
// the five that replace it:
//
//   1. The address is NEVER the handle, and since #3575 nothing derived
//      from it is either. email-signup.js writes an opaque placeholder; the
//      #2563 suggestion (the local part, prefilled wherever the person was
//      asked) is gone, because a prefill one press accepts is a username
//      generated from the email — what #3575 asked us not to do. Every
//      field that asks for the handle starts empty and says, beside it,
//      that the name will be public.
//   2. The gate is SERVER state. `users.needs_username_choice` is written
//      where the account is created and read by /api/auth/me as a new
//      boolean; no client infers it from what the name looks like.
//   3. Existing accounts whose handle IS their address are flagged by a
//      backfill that matches the two columns exactly, not by a shape test.
//   4. POST /api/me/username/choose is a FIRST choice, not a rename: no
//      password (an email-code account has none), no cooldown, no
//      `username_history` row — and it fires exactly once per account,
//      because the UPDATE is gated on the flag it clears.
//   5. The step cannot be skipped: the shell lifts it as a non-dismissible
//      kit modal and the terms gate sequences behind it.
//
// Pure-function tests, HTTP tests against a throwaway express app and a
// substring-dispatching mock pool (the idiom of
// tests/username-change.test.js), and source/schema pins for the parts no
// mock can prove — no live DB. tests/email-signup-postgres.test.js covers
// the insert against a real one.
//
// Run with: node --test tests/username-first-choice.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const usernames = require('../src/services/usernames');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

// ═══════════════════════════════════════════════════════════════════════
// 1–2. What a new account holds until it chooses
// ═══════════════════════════════════════════════════════════════════════
//
// These two sections used to pin the #2563 suggestion — how an address's
// local part became a prefilled handle and how it walked past taken names.
// #3575 removed the suggestion outright ("do not just generate a username
// from their email"), so what is left to pin is the placeholder, and that
// nothing that derives a handle from an email exists to be called again.

test('the placeholder is opaque, valid, and not an address', () => {
  const placeholder = usernames.placeholderUsername();
  assert.equal(usernames.validateUsername(placeholder).ok, true);
  assert.equal(placeholder.includes('@'), false);
  assert.match(placeholder, /^member_[0-9a-f]{18}$/);
  assert.notEqual(placeholder, usernames.placeholderUsername());
});

test('nothing derives a handle from an email address any more (#3575)', () => {
  for (const gone of ['suggestUsernameFromEmail', 'suggestAvailableUsernameFromEmail',
    'isPlaceholderUsername']) {
    assert.equal(gone in usernames, false, `${gone} is retired`);
  }
  for (const rel of ['src/services/usernames.js', 'src/services/email-signup.js',
    'src/routes/profile.js', 'src/routes/auth.js']) {
    assert.doesNotMatch(read(rel), /suggest(?:Available)?UsernameFromEmail\(|firstRunSuggestion\(/,
      `${rel} still calls an email-derived suggestion`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The mock pool and the endpoints
// ═══════════════════════════════════════════════════════════════════════

function makeMockPool(state) {
  const calls = [];
  const run = async (rawSql, params = []) => {
    const sql = collapse(rawSql);
    calls.push({ sql, params });

    if (sql.startsWith('SELECT needs_username_choice FROM users WHERE id')) {
      return { rows: state.me ? [{ needs_username_choice: state.me.needsChoice }] : [] };
    }
    if (sql.startsWith('SELECT id FROM users WHERE LOWER(username)')) {
      const hit = state.live.find((u) => u.username.toLowerCase() === params[0]);
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (sql.startsWith('SELECT user_id FROM username_history WHERE LOWER(username)')) {
      const hit = state.retired.find((h) => h.username.toLowerCase() === params[0]);
      return { rows: hit ? [{ user_id: hit.user_id }] : [] };
    }
    if (sql.startsWith('UPDATE users SET username = $1, needs_username_choice = FALSE')) {
      // The WHERE clause is the authorization — mirror it exactly.
      if (!state.me || !state.me.needsChoice) return { rows: [] };
      state.me.username = params[0];
      state.me.needsChoice = false;
      return { rows: [{ username: params[0] }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
  };
  return { pool: { query: run, connect: async () => ({ query: run, release: () => {} }) }, calls };
}

const ME = { id: 7, username: 'ada@example.com', isAdmin: false };

function freshState(over = {}) {
  return {
    me: {
      id: 7,
      username: 'ada@example.com',
      email: 'ada@example.com',
      needsChoice: true,
    },
    live: [{ id: 7, username: 'ada@example.com' }, { id: 8, username: 'bob' }],
    retired: [],
    ...over,
  };
}

// Both the route module AND rate-limits.js are purged first: the choose
// limiter is keyed on the user id and every test here acts as the same
// user, so a shared counter would 429 a later test regardless of what it
// was asserting.
function appAround(pool, user) {
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/middleware/rate-limits')];
    delete require.cache[require.resolve('../src/routes/profile')];
    routes = require('../src/routes/profile').profileRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return app;
}

function makeApp(state, { user = ME } = {}) {
  const { pool, calls } = makeMockPool(state);
  return { app: appAround(pool, user), calls, state };
}

async function call(app, method, url, payload) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

const choose = (app, payload) => call(app, 'POST', '/api/me/username/choose', payload);

test('choosing installs the handle and clears the gate', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  const res = await choose(app, { username: 'ada_lovelace' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { username: 'ada_lovelace' });
  assert.equal(state.me.username, 'ada_lovelace');
  assert.equal(state.me.needsChoice, false);
});

test('no password is asked for — an email-code account has none', async () => {
  const { app, calls } = makeApp(freshState());
  const res = await choose(app, { username: 'ada_lovelace' });
  assert.equal(res.status, 200);
  assert.equal(calls.some((c) => /password/i.test(c.sql)), false);
});

test('the old address is NOT retired into the handle ledger', async () => {
  // The ledger is read by every handle resolver on the platform. Writing
  // an email address into it puts the address one
  // /api/public/profiles/<name> away from being public — and nobody ever
  // mentioned, linked or declared it as a handle in the first place.
  const state = freshState();
  const { app, calls } = makeApp(state);
  await choose(app, { username: 'ada_lovelace' });
  assert.equal(calls.some((c) => c.sql.startsWith('INSERT INTO username_history')), false);
  assert.deepEqual(state.retired, []);
});

test('no cooldown is read: a first choice is not handle churn', async () => {
  const { app, calls } = makeApp(freshState());
  await choose(app, { username: 'ada_lovelace' });
  assert.equal(calls.some((c) => c.sql.includes('SELECT changed_at')), false);
});

test('an invalid handle is refused with the sentence the field pins', async () => {
  const { app, calls } = makeApp(freshState());
  const res = await choose(app, { username: 'ada lovelace' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /letters, numbers and underscores/i);
  // Shape first: an invalid name must not cost an availability answer.
  assert.equal(calls.length, 0);
});

test('too short, too long and empty are each refused', async () => {
  for (const [name, pattern] of [
    ['ab', /at least 3/i],
    ['a'.repeat(33), /at most 32/i],
    ['   ', /Enter a username/i],
  ]) {
    const { app } = makeApp(freshState());
    const res = await choose(app, { username: name });
    assert.equal(res.status, 400, name);
    assert.match(res.body.error, pattern);
  }
});

test('the platform service namespace is refused here too', async () => {
  const { app } = makeApp(freshState());
  const res = await choose(app, { username: 'usernode_ops' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /reserved/i);
});

test('a handle somebody else holds is a 409, and nothing is written', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  const res = await choose(app, { username: 'bob' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /taken/i);
  assert.equal(state.me.username, 'ada@example.com');
  assert.equal(state.me.needsChoice, true);
});

test('a handle somebody else RETIRED is refused in the same words', async () => {
  const state = freshState({ retired: [{ user_id: 8, username: 'grace' }] });
  const { app } = makeApp(state);
  const res = await choose(app, { username: 'grace' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /taken/i);
});

test('the gate fires once: a replay is answered alreadyChosen, not a second free rename', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  assert.equal((await choose(app, { username: 'ada_lovelace' })).status, 200);

  const replay = await choose(app, { username: 'somethingelse' });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.alreadyChosen, true);
  assert.equal(state.me.username, 'ada_lovelace', 'the second name must not land');
});

test('401 without a session, and nothing is read', async () => {
  const { app, calls } = makeApp(freshState(), { user: null });
  const res = await choose(app, { username: 'ada_lovelace' });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('the suggestion route is gone, and reads nothing (#3575)', async () => {
  // GET /api/me/username/suggestion handed the first-run step a handle
  // derived from the email's local part to arrive holding. With the prefill
  // retired it has no caller, and a route that generates a username from
  // the email is exactly what the request asked us to stop doing.
  const { app, calls } = makeApp(freshState());
  const res = await call(app, 'GET', '/api/me/username/suggestion');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. The signup that no longer stores an address
// ═══════════════════════════════════════════════════════════════════════

const signupJs = read('src/services/email-signup.js');

test('the users INSERT no longer puts the email in the username column', () => {
  // The old shape was `VALUES ($1, $2, $3, ...)` with `[email, hash, email]`
  // — the address in both the username and the email slot.
  assert.doesNotMatch(signupJs, /\[email, unusablePasswordHash, email\]/);
  assert.match(signupJs, /\[candidate, passwordHash, email\]/);
});

test('the created row is marked as still needing a choice', () => {
  // Communities, stage 5 added the join screen's flag to the same INSERT,
  // one step later in the same first run: TRUE for both. The one list
  // (2026-10-01) added the new account's Getting started gate beside them.
  assert.match(signupJs,
    /needs_username_choice, needs_communities_choice,\s*\n\s*getting_started_gate\)\s*\n\s*VALUES \(\$1, \$2, \$3, TRUE, NOW\(\), FALSE, FALSE, TRUE, TRUE, TRUE\)/);
});

test('the username is an opaque placeholder, never derived from the address (#3575)', () => {
  assert.match(signupJs, /let candidate = usernames\.placeholderUsername\(\);/);
});

test('set-password will not finish a new account without a handle (#3575)', () => {
  const complete = signupJs.slice(signupJs.indexOf('async function completePassword'));
  const required = complete.indexOf('if (!chosen && signup.needs_username_choice === true) {');
  const spend = complete.indexOf('DELETE FROM web_signup_sessions');
  assert.ok(required > 0 && required < spend,
    'the refusal comes before the signup session is spent');
  assert.match(complete, /throw new EmailSignupError\('username_required', usernames\.validateUsername\(''\)\.error\);/);
});

test('a colliding placeholder is retried inside a SAVEPOINT, but an email collision is not', () => {
  // The transaction still holds the consumed OTP; a failed statement
  // without a savepoint poisons it. And a second username cannot resolve a
  // clash on the email index, so that one is re-thrown.
  assert.match(signupJs, /SAVEPOINT email_signup_username/);
  assert.match(signupJs, /ROLLBACK TO SAVEPOINT email_signup_username/);
  assert.match(signupJs, /error\.constraint\.includes\('email'\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Server state: the column, the backfill and the payload
// ═══════════════════════════════════════════════════════════════════════

test('the column is added the way every other users column is', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_username_choice BOOLEAN NOT NULL DEFAULT FALSE;/);
  // The preview_operations block has to stay last in the file — see its
  // own comment and tests/preview-lifecycle.test.js.
  assert.ok(
    schema.indexOf('needs_username_choice')
      < schema.indexOf('CREATE TABLE IF NOT EXISTS preview_operations'),
    'the new column must sit above the trailing preview_operations block');
});

test('the backfill matches the two columns exactly, not "looks like an email"', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /backfillUsernameChoiceForEmailHandles\(pool\);/);
  assert.match(migrate, /LOWER\(username\) = LOWER\(email\)/);
  // Nothing anywhere may gate on the SHAPE of the stored name.
  assert.doesNotMatch(migrate, /username\s*(?:~|LIKE)\s*'%@%'/i);
});

test('the backfill is safe to re-run: a chosen account can never be re-flagged', () => {
  const migrate = read('src/db/migrate.js');
  const body = migrate.slice(migrate.indexOf('async function backfillUsernameChoiceForEmailHandles'));
  assert.match(body.slice(0, 600), /needs_username_choice = FALSE/);
});

test('/api/auth/me carries the gate as a NEW boolean, changing no existing field', () => {
  const authJs = read('src/routes/auth.js');
  assert.match(authJs, /u\.needs_username_choice,/);
  assert.match(authJs, /needsUsernameChoice = rows\[0\]\?\.needs_username_choice === true;/);
  assert.match(authJs, /\n\s*needsUsernameChoice,\n/);
  // `username` is still whatever the account holds — untouched.
  assert.match(authJs, /username: req\.user\.username,/);
});

test('the gate defaults FALSE, so an unreadable flag lets people in', () => {
  const authJs = read('src/routes/auth.js');
  assert.match(authJs, /let needsUsernameChoice = false;/);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. The screen — source pins, as tests/terms-first-run.test.js does
// ═══════════════════════════════════════════════════════════════════════

const gateJs = read('frontend/src/features/auth/username-first-run.js');
const termsJs = read('frontend/src/features/settings/terms-first-run.js');
const dapp = JSON.parse(read('dapp.json'));

test('the gate rides the shell bundle, not a new public/js script', () => {
  assert.match(read('frontend/src/main.tsx'),
    /import '\.\/features\/auth\/username-first-run\.js';/);
  assert.ok(!read('public/sw.js').includes('username-first-run'),
    'no SHELL_ASSETS entry — the module is bundled, not a shell script');
});

test('the gate reads the server flag, never the shape of the stored name', () => {
  assert.match(gateJs, /window\.App\.user\.needsUsernameChoice !== true/);
  assert.doesNotMatch(gateJs, /includes\('@'\)|indexOf\('@'\)|@.*\\\./);
});

test('the step cannot be skipped: a non-dismissible modal with no Close', () => {
  assert.match(gateJs, /PlatformUI\.modal\(\{ contentEl: panel, dismissible: false \}\)/);
  assert.doesNotMatch(gateJs, /'Close'|'Cancel'|'Skip'/);
});

test('it presents at once, with an empty field and nothing fetched to fill it (#3575)', () => {
  // The gate used to go up first and then fill the field with a suggestion
  // derived from the email when a round trip landed. There is no round trip
  // now: nothing arrives to fill it, and the person types their own.
  assert.match(gateJs, /UsernameFirstRun\._present\(\{\}\);/);
  assert.doesNotMatch(gateJs, /fetch\('\/api\/me\/username\/suggestion'/);
  assert.doesNotMatch(gateJs, /input\.value = |setAttribute\('data-username-suggested'/);
  assert.doesNotMatch(gateJs, /_fill\(/);
});

test('beside the field, every sign-up surface says the username will be public (#3575)', () => {
  const shared = read('frontend/src/features/auth/shared.ts');
  const note = 'Your username will be public to other users on Homeroom.';
  assert.match(shared, /export const USERNAME_PUBLIC_NOTE = 'Your username will be public to other users on Homeroom\.';/);
  // The gate is a classic module with no imports, so it spells the words;
  // this is what holds the two copies together.
  assert.ok(gateJs.includes(`const PUBLIC_NOTE = '${note}';`));
  // Right after the input, ahead of the error line, so a refusal never
  // displaces it — and the input names it for a screen reader.
  const inputAt = gateJs.indexOf('panel.appendChild(input);');
  const noteAt = gateJs.indexOf('panel.appendChild(note);');
  const errorAt = gateJs.indexOf("status.setAttribute('data-choose-username-error', '');");
  assert.ok(inputAt > 0 && noteAt > inputAt && errorAt > noteAt);
  assert.match(gateJs, /input\.setAttribute\('aria-describedby', 'choose-username-public'\);/);
  assert.match(gateJs, /note\.setAttribute\('data-choose-username-public', ''\);/);

  // The register form and the email sign-up's set-password step render the
  // shared constant on its own line, directly under the input.
  const register = read('frontend/src/features/auth/register.tsx');
  assert.match(register,
    /aria-describedby="reg-username-public reg-username-hint"[\s\S]{0,700}?<p id="reg-username-public" className=\{FIELD_HINT\}>\s*\{USERNAME_PUBLIC_NOTE\}\s*<\/p>\s*<p\s+id="reg-username-hint"/);
  const login = read('frontend/src/features/auth/login.tsx');
  assert.match(login,
    /aria-describedby="otp-username-public otp-username-hint"[\s\S]{0,300}?\/>\s*<p id="otp-username-public" className=\{FIELD_HINT\}>\s*\{USERNAME_PUBLIC_NOTE\}\s*<\/p>\s*<p id="otp-username-hint"/);
});

test('screenshot and demo routes are skipped, except this step own shot', () => {
  assert.match(gateJs, /const SHOT = 'choose-username';/);
  assert.match(gateJs, /params\.get\('shot'\) \|\| params\.get\('demo'\)/);
  assert.match(gateJs, /_sessionFromSnapshot\) \{/);
});

test('the shot state writes nothing', () => {
  assert.match(gateJs, /if \(opts && opts\.demo\) \{/);
});

test('boot pattern: init now if authed, else the once-per-document sv:authed', () => {
  assert.match(gateJs, /window\.App && window\.App\.user\) UsernameFirstRun\.maybePrompt\(\);/);
  assert.match(gateJs, /addEventListener\('sv:authed',[\s\S]{0,80}\{ once: true \}\)/);
});

test('a success moves App.user, so nothing in this tab keeps the old handle', () => {
  assert.match(gateJs, /window\.App\.user\.username = body\.username;/);
  assert.match(gateJs, /window\.App\.user\.needsUsernameChoice = false;/);
  assert.match(gateJs, /saveSessionSnapshot\?\.\(window\.App\.user\)/);
});

test('the terms gate sequences BEHIND this one, and only when it applies', () => {
  assert.match(termsJs, /UsernameFirstRun\.applies\(\)/);
  assert.match(termsJs, /await UsernameFirstRun\.settled\(\);/);
  assert.match(gateJs, /applies\(\) \{/);
  assert.match(gateJs, /settled\(\) \{/);
});

test('the declared checks reach the step and pin its copy', () => {
  const ours = dapp.tests.filter((t) => t.path === '/?shot=choose-username');
  assert.ok(ours.length >= 3, 'the step needs declared checks of its own');
  const visual = ours.filter((t) => t.visual === true);
  assert.equal(visual.length, 1, 'exactly one representative flow is tagged visual');
  assert.ok(visual[0].impact.includes('frontend/src/features/auth/username-first-run.js'));
  // The strings the checks match on live in the module; a reword that
  // breaks them fails here, next to the code, instead of in a proposal
  // check.
  for (const t of ours) {
    if (t.expectText) assert.ok(gateJs.includes(t.expectText), t.expectText);
  }
  assert.ok(gateJs.includes('data-choose-username-save'));
  // #3575: the visual check asserts the field arrives EMPTY (the
  // placeholder is showing) with the public note right after it. It used to
  // assert the opposite — a suggestion already in the field.
  assert.ok(gateJs.includes('data-choose-username-public'));
  assert.match(visual[0].expectSelector,
    /input#choose-username-input:placeholder-shown \+ \[data-choose-username-public\]/);
  assert.doesNotMatch(JSON.stringify(ours), /data-username-suggested/);
});

// ═══════════════════════════════════════════════════════════════════════
// 7. The other account-creation paths
// ═══════════════════════════════════════════════════════════════════════

test('no route anywhere else writes an email address into users.username', () => {
  // Checked at the time of #2563 and pinned so it stays true: wallet
  // registration and the activation-code route take a username the person
  // types, admin-created topochain users get an opaque `topochain_<hex>`,
  // and the fleet/demo seeds name their own. email-signup.js was the only
  // path that reused the address, and no longer does.
  for (const rel of [
    'src/routes/auth.js',
    'src/routes/topochain/admin/users.js',
    'src/services/fleet-maintenance.js',
    'src/routes/demo-mode.js',
  ]) {
    const source = read(rel);
    const inserts = source.match(/INSERT INTO users[\s\S]{0,400}?\]\s*\)/g) || [];
    for (const insert of inserts) {
      assert.doesNotMatch(insert, /\[\s*email\b/,
        `${rel}: an INSERT INTO users leads with the email address`);
    }
  }
});

test('every path that makes an account for a person has them choose its handle (#3575)', () => {
  // The map, as of #3575. Each sign-up path either takes a handle the
  // person typed, or marks the account `needs_username_choice` so it is
  // asked before it is let in:
  //
  //   • email code      — placeholder + flag; set-password refuses to finish
  //                       without a handle (section 4, and
  //                       tests/email-signup-postgres.test.js)
  //   • activation code — the register form's username, validateUsername
  //                       (tests/register-account-rules.test.js)
  //   • genesis wallet  — POST /api/auth/wallet-register's username, typed
  //                       by the person in an external wallet client. It
  //                       takes any non-empty string; adopting the register
  //                       rule waits on checking that client, so it is left
  //                       as it is here.
  //   • admin-created   — `topochain_<hex>` + flag, so the person picks
  //                       their own at their first sign-in instead of
  //                       entering wearing a generated string
  //
  // Invite links, the waitlist, the CLI device flow and the MCP connector
  // make no account of their own: they ride one of the above, or a session
  // that already exists.
  const auth = read('src/routes/auth.js');
  {
    const route = "router.post('/api/auth/register'";
    const body = auth.slice(auth.indexOf(route));
    const validate = body.indexOf('usernames.validateUsername(username)');
    const insert = body.indexOf('INSERT INTO users');
    assert.ok(validate > 0 && validate < insert, `${route} validates the typed handle before it inserts`);
  }
  {
    // The wallet route still requires a typed name (no generated one).
    const body = auth.slice(auth.indexOf("router.post('/api/auth/wallet-register'"));
    assert.match(body.slice(0, 400), /if \(!username\?\.trim\(\) \|\| !password \|\| !pubkey\?\.trim\(\)\)/);
  }

  const admin = read('src/routes/topochain/admin/users.js');
  // One line of columns, one line of values (`.` stops at the newline).
  const inserts = [...admin.matchAll(/INSERT INTO users \(([^)]*)\)\s*VALUES \((.*)\)/g)];
  assert.equal(inserts.length, 2, 'the single create and the bulk import');
  for (const [, columns, values] of inserts) {
    assert.match(columns, /, needs_username_choice$/);
    assert.match(values, /, TRUE$/, 'an admin-created account owes its person a choice');
  }
});
