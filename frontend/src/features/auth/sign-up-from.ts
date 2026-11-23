/**
 * Which button on the signed-out pages a sign-up came from, for the
 * `user_signed_up` event (src/services/sign-up-from.js reads it).
 *
 * Each button notes itself as it opens a sign-in sheet: the story's
 * (./story.tsx: Continue, its Sign in line; the hero's is the looks' frame's,
 * ../guest/frame/landing-frame.tsx), the landing's own (./landing.tsx:
 * the bar's Sign in and Sign up, what the visitor tried on a project's page,
 * and the sheet a shared link opens by itself) and the page about private
 * communities' (`groups`, ../guest/guest-communities.tsx). It travels
 * as a short-lived first-party cookie because one of the ways in leaves the
 * page and comes back: Apple's and Google's sign-ins finish on the
 * provider's callback, a top-level navigation that carries a SameSite=Lax
 * cookie and nothing the page held. An email code and a phone number finish
 * on a same-origin POST, which carries it too.
 *
 * It names a button and nothing about the person. Opening another sheet
 * replaces it; an hour on, it is gone. Kept in step with the server's list
 * (tests/sign-up-from.test.js).
 */

export const SIGN_UP_FROM_COOKIE = 'hr_signup_from';

export const SIGN_UP_FROM = [
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
] as const;
export type SignUpFrom = (typeof SIGN_UP_FROM)[number];

const MAX_AGE_S = 60 * 60;

/** Note the button a sheet was opened from. Never throws: the sign-in does not depend on it. */
export function noteSignUpFrom(from: SignUpFrom): void {
  if (typeof document === 'undefined') return;
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${SIGN_UP_FROM_COOKIE}=${from}; Max-Age=${MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // A browser that refuses the cookie only loses the label.
  }
}
