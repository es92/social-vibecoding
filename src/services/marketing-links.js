'use strict';

// Links into the public MARKETING site, as opposed to links into the app.
//
// The distinction matters because the two hosts answer different questions.
// `my.onhomeroom.com` is the shell: it boots the SPA, asks for a token, and
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

// The shareable invite URL for one signup's referral code.
//
// Returns null for a signup with no code yet — the caller renders no link at
// all in that case, which is the honest answer, rather than a URL whose
// `ref=` is empty and would attribute the join to nobody.
function inviteUrl(config, code) {
  if (!code) return null;
  const base = normalizeBaseUrl(config && config.marketingBaseUrl);
  return `${base}${MARKETING_WAITLIST_PATH}?ref=${encodeURIComponent(code)}`;
}

module.exports = {
  DEFAULT_MARKETING_BASE_URL,
  MARKETING_WAITLIST_PATH,
  normalizeBaseUrl,
  inviteUrl,
};
