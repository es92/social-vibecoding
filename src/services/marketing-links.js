'use strict';

// Links into the public MARKETING site, as opposed to links into the app.
//
// The distinction matters because the two hosts answer different questions.
// `app.onhomeroom.com` is the shell: it boots the SPA, asks for a token, and
// renders `#waitlist` for somebody who is already looking at the product.
// The marketing site is what a stranger should meet — an invite link is
// almost always pasted into a group chat, opened on a phone by somebody who
// has never heard of this, and the page it lands on has to do the explaining.
//
// So a shared invite link points at `<marketing origin>/waitlist?ref=<code>`
// and the in-app `#waitlist` route is left exactly as it was. Every surface
// that renders an invite link builds it here, so the host is decided once.
//
// The origin is configurable (MARKETING_BASE_URL, declared in dapp.json's
// platform_env) because a self-hosted deployment has its own marketing site,
// or none, and hardcoding the hosted one would silently send its users to a
// page about somebody else's product.

const DEFAULT_MARKETING_BASE_URL = 'https://onhomeroom.com';

// The marketing site's waitlist page. Its `?ref=` code is the same code the
// join endpoint accepts as `invite_code`, so the marketing form can forward
// it back unchanged (src/routes/public-api.js).
const MARKETING_WAITLIST_PATH = '/waitlist';

// Trim a configured origin down to something safe to concatenate a path
// onto: no surrounding whitespace, no trailing slash. A value that is empty
// or not a string falls back rather than producing `undefined/waitlist`.
function normalizeBaseUrl(value, fallback = DEFAULT_MARKETING_BASE_URL) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const base = trimmed || fallback;
  return String(base).replace(/\/+$/, '');
}

// The marketing site's waitlist page itself, with no referral attached.
//
// The landing's primary pill points here: somebody who arrived by typing the
// app host has no `ref` to carry, and an empty `?ref=` would attribute the
// join to nobody — the same reason inviteUrl() below returns null rather than
// an empty code.
//
// Unlike inviteUrl this is NEVER null: normalizeBaseUrl already falls back to
// DEFAULT_MARKETING_BASE_URL, so the result is always a usable absolute
// string. Clients (including GET /api/public/waitlist/options) can rely on
// that stronger contract.
//
// One configuration caveat worth knowing rather than coding around: if
// MARKETING_BASE_URL is ever pointed at the app's own origin, the native
// shell's external-link handler (public/js/nav-link.js) treats the link as
// same-origin and leaves it to the webview, which cannot navigate off the
// bound domain. normalizeBaseUrl also does not validate the scheme, so a
// value like `example.test` resolves relative to the app origin for the same
// reason. Both are misconfigurations of the platform variable, not of a
// caller, and inviteUrl has always had them too.
function waitlistUrl(config) {
  const base = normalizeBaseUrl(config && config.marketingBaseUrl);
  return `${base}${MARKETING_WAITLIST_PATH}`;
}

// The marketing site's FRONT DOOR, with no path at all.
//
// The logged-out landing says what this place is in one sentence, which is
// the right length for a first screen and far too short for somebody weighing
// up whether to join. `siteUrl` is where that person goes to read the long
// version — the same site the invite link lands on, minus the form.
//
// Never null, for waitlistUrl's reason: normalizeBaseUrl always falls back.
// It returns the origin with no trailing slash, so a caller that wants a path
// concatenates one and a caller that wants the home page uses it as is.
function siteUrl(config) {
  return normalizeBaseUrl(config && config.marketingBaseUrl);
}

// The shareable invite URL for one signup's referral code.
//
// Returns null for a signup with no code yet — the caller renders no link at
// all in that case, which is the honest answer, rather than a URL whose
// `ref=` is empty and would attribute the join to nobody.
//
// Built on waitlistUrl() so the host and the path stay decided in one place;
// the output string is unchanged (`<base>/waitlist?ref=<code>`), which two
// declared checks in dapp.json select on by prefix.
function inviteUrl(config, code) {
  if (!code) return null;
  return `${waitlistUrl(config)}?ref=${encodeURIComponent(code)}`;
}

module.exports = {
  siteUrl,
  DEFAULT_MARKETING_BASE_URL,
  MARKETING_WAITLIST_PATH,
  normalizeBaseUrl,
  waitlistUrl,
  inviteUrl,
};
