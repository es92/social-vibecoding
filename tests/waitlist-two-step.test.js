// The check-my-status errand is two steps, not one form (#1876).
//
// `#waitlist?confirm=1` asked for the address and the six-digit code in one
// breath, and the control that actually SENT the code was a tertiary "Didn't
// get it, or has it expired?" link underneath the field somebody was being
// told to fill in. So the hint claimed there was a code in your email before
// any mail had been sent, and the one action that would have made the claim
// true read as a footnote.
//
// Split: an address step that sends, then a code step that carries a way
// back. The post-join path is deliberately untouched, because there the join
// WAS step 1 and the mail is already out, which is why the assertions below
// all read the `codeOnly` arm.
//
// Three of them are about things that are easy to "improve" back into bugs,
// so they are pinned rather than described:
//
//   - A request the server accepted ALWAYS advances. The resend endpoint
//     answers with one frozen body for everybody, and a step that advanced
//     only for addresses we hold would answer the membership question that
//     body exists to refuse. That is about THIS errand's own send, and #2201
//     does not touch it: the endpoint behind `onRequestCode` still answers
//     one body. The JOIN form is the one that learned to branch, and its
//     confirmed arm is the one case in the screen where an accepted request
//     does not advance — there is no code to enter, so a code step would be
//     a dead end with a cooldown on it. Pinned below.
//   - "I already have a code" sends NOTHING. issueVerificationCode deletes
//     every unconsumed code for an address before minting the next one, so a
//     send here would invalidate the code in the inbox of the very person who
//     followed the status mail's own button to this screen.
//   - The step lives in the fragment and is derived from it on every show, so
//     the browser's Back walks the flow backwards and a reload lands where it
//     left. Setting state without assigning the hash breaks the first; reading
//     the hash in only one direction breaks the second.
//
// Run with: node --test tests/waitlist-two-step.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WAITLIST = read('frontend/src/features/auth/waitlist.tsx');
const APP = read('public/js/app.js');
const DAPP = JSON.parse(read('dapp.json'));

/** The body of a `const <name> = useCallback(` through its dependency list. */
function callback(src, name) {
  const from = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(from > 0, `${name} should exist`);
  const body = src.slice(from, src.indexOf('\n  }, [', from));
  assert.ok(body.length > 0, `${name} should end in a dependency list`);
  return body;
}

test('the two halves are wrapped, and exactly one of them is up', () => {
  // Wrappers rather than per-element class expressions: the whole half comes
  // and goes together. The conditions are each other's negation ON the
  // codeOnly path, and both fall back to today's markup off it.
  assert.match(WAITLIST,
    /id="waitlist-confirm-address"\s*\n\s*className=\{codeOnly && flowStep === 'address' \? '' : 'hidden'\}/);
  assert.match(WAITLIST,
    /id="waitlist-confirm-code"\s*\n\s*className=\{codeOnly && flowStep === 'address' \? 'hidden' : ''\}/);
});

test('the address step owns the send, and the code step owns the code', () => {
  const address = WAITLIST.slice(
    WAITLIST.indexOf('id="waitlist-confirm-address"'),
    WAITLIST.indexOf('id="waitlist-confirm-code"'));
  const code = WAITLIST.slice(WAITLIST.indexOf('id="waitlist-confirm-code"'));
  assert.match(address, /id="waitlist-confirm-email"/, 'the address field is on step 1');
  assert.match(address, /id="waitlist-request-code"/, 'and so is the send');
  assert.doesNotMatch(address, /id="waitlist-code"/, 'the six digits are not');
  assert.match(code, /id="waitlist-code"/);
  assert.match(code, /id="waitlist-change-email"/, 'step 2 carries the way back');
  assert.match(code, /id="waitlist-resend"/, 'and the fresh-code offer');
});

test('a request the server accepted advances, whatever the address was', () => {
  const body = callback(WAITLIST, 'onRequestCode');
  const ok = body.slice(body.indexOf('if (res.ok) {'), body.indexOf('setRequestNote({\n        text: (data'));
  assert.ok(ok.includes('goToCodeStep();'),
    'the ok arm advances unconditionally');
  // Nothing in that arm may consult the response for a membership answer:
  // the body is a constant, and branching on it would invent a signal.
  assert.doesNotMatch(ok, /data\.(found|exists|on_list|member)/);
  assert.doesNotMatch(ok, /if \(data\b/);
});

test('and one it refused stays put, with its own line', () => {
  const body = callback(WAITLIST, 'onRequestCode');
  assert.match(body, /setRequestNote\(\{ text: 'Enter your email address first\.', tone: 'error' \}\)/);
  assert.match(body, /setRequestNote\(\{\s*text: \(data && data\.error\) \|\| 'Something went wrong\. Try again\.'/);
  assert.match(body, /setRequestNote\(\{ text: 'Connection issue\. Try again\.', tone: 'error' \}\)/);
  // The failure paths do not advance: goToCodeStep is called once, in the ok
  // arm asserted above.
  assert.equal((body.match(/goToCodeStep\(\)/g) || []).length, 1);
});

test('"I already have a code" sends nothing', () => {
  const body = callback(WAITLIST, 'onHaveCode');
  assert.doesNotMatch(body, /fetch\(/,
    'issuing a code deletes the unconsumed one, which is the code they came to type');
  assert.doesNotMatch(body, /setSentTo/,
    'and nothing was sent, so the next step must not say an address was mailed');
  assert.match(body, /goToCodeStep\(\)/);
});

test('the step is in the fragment, and read back from it on every show', () => {
  // Forwards: both moves assign the hash, which is what makes the browser's
  // own Back a working undo.
  assert.match(callback(WAITLIST, 'goToCodeStep'),
    /location\.hash = '#waitlist\?confirm=1&step=code'/);
  assert.match(callback(WAITLIST, 'backToAddress'),
    /location\.hash = '#waitlist\?confirm=1'/);
  // Backwards: `waitlistOnShow` runs on every show, including a hashchange,
  // and derives BOTH values rather than only the forward one.
  assert.match(WAITLIST,
    /setFlowStep\(hashQuery\.get\('step'\) === 'code' \? 'code' : 'address'\)/);
});

test('a code step reached with no address goes back instead of posting', () => {
  // An address never travels in a URL, so a deep link to step 2 has none
  // behind it. The server can only refuse that in the one shape that
  // deliberately says nothing, which is not an answer worth showing.
  const body = callback(WAITLIST, 'onConfirmCode');
  const guard = body.slice(0, body.indexOf('/^[0-9]{6}$/'));
  assert.match(guard, /if \(codeOnly && !confirmAddress\(\)\) \{/);
  assert.match(guard, /backToAddress\(\)/);
  assert.ok(!guard.includes('fetch('), 'and it does so before any POST');
});

test('the eyebrow names which step you are on', () => {
  assert.match(WAITLIST, /'Step 2 of 2 · Enter your code'/);
  assert.match(WAITLIST, /'Step 1 of 2 · Your email address'/);
});

test('the lede stops instructing the reader to use a field they cannot see', () => {
  // Step 2 hides the address input, so the screen's opening sentence keeps the
  // claim and drops the instruction. It must also stay silent about a mail
  // having been sent, because "I already have a code" reaches step 2 with no
  // send behind it.
  // Read the branch itself rather than a slice around it: the change's own doc
  // comment quotes the sentence that moved, and the step-1 branch beside it
  // still says "email you a code" on purpose.
  // Two things branch on the step; the eyebrow's arm is a "Step N of 2" label.
  const arms = Array.from(
    WAITLIST.matchAll(/\? flowStep === 'code'\s*\n\s*\? '([^']*)'/g), (m) => m[1]);
  const lede = arms.filter((text) => !text.startsWith('Step '));
  assert.equal(lede.length, 1, 'exactly one step-2 sentence, not a label');
  assert.equal(lede[0],
    'This shows where you stand, and confirms your address if it still needs it.');
  assert.ok(!/sent|email/.test(lede[0]),
    'the step-2 lede claims no send: "I already have a code" gets here without one');
  assert.match(WAITLIST, /Enter the address you joined with and we\\u2019ll email you a code\./,
    'and step 1 says exactly what it always said');
});

test('both steps are photographable, and declared', () => {
  // A capture can only navigate, so the second step needs a shot of its own.
  assert.match(APP, /shot !== 'waitlist-code-step'/, 'the anonymous-boot gate');
  assert.match(APP, /shot === 'waitlist-code-step'/, 'and the fragment normaliser');
  assert.match(WAITLIST, /const shotCodeStep = shot === 'waitlist-code-step';/);

  const at = (p) => DAPP.tests.filter((t) => t.path === p);
  const step1 = at('/?shot=waitlist-code-entry');
  const step2 = at('/?shot=waitlist-code-step');
  assert.ok(step1.some((t) => /#waitlist-confirm-address:not\(\.hidden\)/.test(t.expectSelector)));
  assert.ok(step1.some((t) => t.expectSelector === '#waitlist-confirm-code.hidden'));
  assert.ok(step2.some((t) => /#waitlist-confirm-code:not\(\.hidden\) #waitlist-code$/.test(t.expectSelector)));
  assert.ok(step2.some((t) => t.expectSelector === '#waitlist-confirm-address.hidden'));
  assert.ok(step2.some((t) => /#waitlist-change-email/.test(t.expectSelector)));
});

test('a confirmed re-join skips the code step, cooldown and all (#2201)', () => {
  // The join form's three answers, and the one asymmetry between them. Cases
  // 1 and 2 mailed a code, so they go where the code is typed and arm the gap
  // the mail throttle will enforce anyway. Case 3 minted nothing, mailed
  // nothing and deleted nothing, so both of those would be lies: a code step
  // with no code on its way, and a countdown on a resend that would be
  // refused.
  const body = callback(WAITLIST, 'onSubmit');
  const at = body.indexOf('if (joinStatus && joinStatus.confirmed) {');
  assert.ok(at > 0, 'onSubmit branches on the status block, not on the message');
  // The inner else, nested one level deeper than `if (res.ok)`'s own.
  const split = body.indexOf('\n          } else {', at);
  assert.ok(split > at, 'and the other two cases share the else arm');
  const confirmedArm = body.slice(at, split);
  const otherArm = body.slice(split);

  // The confirmed arm sets the settled panel up and stops.
  assert.match(confirmedArm, /setAlreadyConfirmed\(true\);/);
  assert.match(confirmedArm, /setConfirmed\(true\);/);
  assert.match(confirmedArm, /setStatus\(joinStatus\);/);
  assert.match(confirmedArm, /setOffer\(false\);/,
    'a re-join carries no token, so the survey link has nowhere to go');
  assert.doesNotMatch(confirmedArm, /setFlowStep\(/, 'no step to move to');
  assert.doesNotMatch(confirmedArm, /goToCodeStep\(/);
  assert.doesNotMatch(confirmedArm, /startCooldown\(/, 'and no gap to arm');
  assert.doesNotMatch(confirmedArm, /code\.current\?\.focus/,
    'nothing to focus: the code field is hidden on this panel');
  assert.doesNotMatch(confirmedArm, /setMoreToken\(/);

  // The other arm still does both, for both of the cases that reach it.
  assert.match(otherArm, /startCooldown\(\);/);
  assert.match(otherArm, /code\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.equal((body.match(/startCooldown\(\)/g) || []).length, 1,
    'the cooldown is armed in exactly one arm');

  // And the flag that separates case 2 from case 1 is the absent token, not a
  // sentence: `more_token` is issued on a first join and never on a re-join.
  assert.match(otherArm, /if \(joinStatus && !token\) setRejoined\(true\);/);
});
