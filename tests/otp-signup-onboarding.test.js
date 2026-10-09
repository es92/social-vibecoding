// QA 2026-09-24 Q12: "Sign in with an email code" for an address with no
// account used to create one silently. After the code it said "Code verified.
// Now choose a password for your account.", then dropped the person in the
// waiting room under a handle they never chose ("Your account qaflowfive
// doesn't have platform access yet"). Nothing said an account was being made,
// or that there was a waitlist.
//
// Now /api/auth/otp/verify reports what it did (additive fields, pinned
// against real PostgreSQL in tests/email-signup-postgres.test.js), and the
// set-password step:
//   * says the code created the account,
//   * asks for the username and sends it with the password (the first-run
//     gate's rules and endpoint semantics),
//   * says plainly, before the waiting room, that new accounts join a
//     waitlist.
//
// #3575 changed the second point twice over. The field used to arrive
// prefilled with a handle derived from the address, and was optional: one
// press of "Create account" signed up under a username generated from the
// email. Now it starts EMPTY, says beside it "Your username will be public to
// other users on Homeroom.", and the server refuses to finish without it.
// #4596 brought the prefill back for this step, on purpose: the field arrives
// holding the letters and digits before the @ (made free by a number when
// taken), the person can change it, and it is still required.
//
// Run with: node --test tests/otp-signup-onboarding.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const LOGIN = read('frontend/src/features/auth/login.tsx');
const AUTH = read('src/routes/auth.js');
const SIGNUP = read('src/services/email-signup.js');

test('the verify answer says what happened, additively, and suggests a name from the address', () => {
  const route = AUTH.slice(AUTH.indexOf("router.post('/api/auth/otp/verify'"));
  // #4596 (overturning #3575 for this step): a suggestion made from the
  // address, only for an account that still owes its handle (null when
  // none fits), and absent otherwise.
  assert.match(route, /next: 'set-password',\s+created: !!verified\.created,\s+needsUsername: !!verified\.needsUsernameChoice,\s+\.\.\.\(verified\.needsUsernameChoice \? \{ suggestedUsername: verified\.suggestedUsername \|\| null \} : \{\}\),\s+waitlisted:/);
  assert.match(SIGNUP, /if \(result\.next === 'set-password' && result\.needsUsernameChoice\) \{\s*result\.suggestedUsername = await suggestedUsername\(pool, email, result\.userId\);/);
  // Best effort: a failed read is an empty field, never a failed code.
  const helper = SIGNUP.slice(SIGNUP.indexOf('async function suggestedUsername'));
  assert.match(helper, /try \{\s*return await usernames\.suggestUsernameForEmail\(pool, email, userId\);\s*\} catch \(error\) \{[\s\S]*?return null;/);
  // Read after linkUserByEmail, which releases an address the waitlist already let in.
  assert.ok(SIGNUP.indexOf('result.waitlisted = await isWaitlisted') > SIGNUP.indexOf('await waitlist.linkUserByEmail'));
  // #4083: a waiting account gets its own spot, after the link (which lets a
  // released address in) and before the waiting state is read.
  const spot = SIGNUP.indexOf('await waitlist.ensureAccountSignup(pool, { userId: result.userId })');
  assert.ok(spot > SIGNUP.indexOf('await waitlist.linkUserByEmail'));
  assert.ok(spot < SIGNUP.indexOf('result.waitlisted = await isWaitlisted'));
});

test('the password step says the account is new, and asks for its handle with the suggestion in the field', () => {
  assert.match(LOGIN, /"Code verified\. No account uses this email yet, so we'll create one\. Choose a username and a password\."/);
  assert.match(LOGIN, /otpSignup\?\.created\s+\? OTP_PASSWORD_INTRO_NEW/);
  const field = LOGIN.slice(LOGIN.indexOf('id="otp-username"'), LOGIN.indexOf('id="otp-username-hint"'));
  assert.match(field, /\{\.\.\.HANDLE_FIELD\}/, 'no auto-capitalising a handle');
  // #4596: the field arrives holding the server's suggestion ('' for none),
  // and stays the person's to change.
  assert.match(field, /defaultValue=\{otpSignup\.suggestedUsername\}/);
  assert.match(LOGIN, /suggestedUsername: typeof data\.suggestedUsername === 'string' \? data\.suggestedUsername : '',/);
  assert.doesNotMatch(field, /data-username-suggested|readOnly/);
  // Beside it, who will see it; then the rule, or the server's refusal.
  assert.match(field, /aria-describedby="otp-username-public otp-username-hint"/);
  assert.match(field, /<p id="otp-username-public" className=\{FIELD_HINT\}>\s*\{USERNAME_PUBLIC_NOTE\}\s*<\/p>/);
  assert.match(LOGIN, /\{otpUsernameError \|\| USERNAME_RULE\}/);
  assert.match(LOGIN, /\{otpSignup\?\.needsUsername \? \(/, 'only when the account still owes a choice');
  // The handle rides with the password, an empty field is caught before the
  // round trip, and a refusal lands under the field.
  assert.match(LOGIN, /if \(handle === ''\) \{\s+setOtpUsernameError\('Enter a username\.'\);/);
  assert.match(LOGIN, /\.\.\.\(handle \? \{ username: handle \} : \{\}\)/);
  assert.match(LOGIN, /if \(data\.field === 'username' && data\.error\) \{\s+setOtpUsernameError\(data\.error\);/);
});

test('the waitlist is named before the waiting room, not by it', () => {
  assert.match(LOGIN, /'New accounts get a spot on the waitlist\. We\\u2019re letting people in a few at a time\.'/);
  assert.doesNotMatch(LOGIN, /in the queue|your turn/);
  assert.match(LOGIN, /\{otpSignup\?\.waitlisted \? \(\s+<p id="otp-waitlist-note"/);
});

test('set-password spends the signup session only on a name it accepts', () => {
  const complete = SIGNUP.slice(SIGNUP.indexOf('async function completePassword'));
  const required = complete.indexOf('return { usernameRequired: true };');
  const check = complete.indexOf('usernames.checkAvailability(client, chosen, signup.user_id)');
  const spend = complete.indexOf('DELETE FROM web_signup_sessions');
  assert.ok(required > 0 && required < spend, 'a missing name is refused before the session is deleted');
  assert.ok(check > 0 && check < spend, 'availability is checked before the session is deleted');
  assert.match(complete, /usernames\.chooseFirstUsername\(client, signup\.user_id, chosen\)/,
    'the same needs_username_choice-guarded write as the first-run gate');
  const route = AUTH.slice(AUTH.indexOf("router.post('/api/auth/otp/set-password'"));
  assert.match(route, /error\.code === 'invalid_username' \|\| error\.code === 'username_taken'\s+\|\| error\.code === 'username_required'\) \{\s+return res\.status\(422\)\.json\(\{ error: error\.message, code: error\.code, field: 'username' \}\);/,
    'and the route keeps the signup cookie for every username refusal');
});
