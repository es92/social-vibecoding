'use strict';

// Which button on the signed-out pages a sign-up came from: the `from` of
// a `user_signed_up` event's metadata, beside its `via` (email, apple,
// google, phone, …).
//
// The signed-out pages note it in a short-lived first-party cookie as a
// sign-in sheet opens (frontend/src/features/auth/sign-up-from.ts, which
// says why a cookie): the hero's button, the bar's Sign in or Sign up,
// what the visitor tried on a project's page, or the button on the page
// about private communities (`groups`). Only a
// name from this list is recorded; anything else, or no cookie, records no
// `from`, and the sign-up is recorded as it always was.
//
// It is for counting which ways in work while new accounts start on the
// waitlist (Evan, 21 Oct 2026). It names a button, never anything about
// the person.

const SIGN_UP_FROM_COOKIE = 'hr_signup_from';

const SIGN_UP_FROM = Object.freeze([
  'hero',
  'header_sign_in',
  'header_sign_up',
  'join',
  'vote',
  'ask',
  'chat',
  'use',
  'story',
  'story_sign_in',
  'link',
  'groups',
]);
const KNOWN = new Set(SIGN_UP_FROM);

/** The button the request's cookie names, or null. */
function signUpFrom(req) {
  const value = req && req.cookies ? req.cookies[SIGN_UP_FROM_COOKIE] : null;
  return typeof value === 'string' && KNOWN.has(value) ? value : null;
}

/** A `user_signed_up` event's metadata, with `from` when the request names one. */
function signUpMetadata(req, metadata) {
  const from = signUpFrom(req);
  return from ? { ...metadata, from } : metadata;
}

module.exports = { SIGN_UP_FROM_COOKIE, SIGN_UP_FROM, signUpFrom, signUpMetadata };
