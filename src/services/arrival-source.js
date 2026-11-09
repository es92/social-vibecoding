'use strict';

// Where a person came from (#6540): the hostname of the page that sent them,
// and the short tags a shared link or a landing URL carries.
//
// Only a hostname is ever kept, never a path, a query or a port, because the
// rest of a URL can carry an address somebody typed into a search box. A
// value that does not fit is dropped rather than stored: a forged `via` or
// utm tag must not reach the database.
//
// Two absences are different, and Journey shows them differently:
//   * null      nothing was recorded (a row from before this change, or a
//               client that did not send the field) — "Not recorded".
//   * 'none'    the source was looked for and none was given — "no referrer".

const HOST_RE = /^[a-z0-9.-]{1,253}$/;
const VIA_RE = /^[a-z0-9-]{1,24}$/;

// A value with no scheme ("discord.com", "t.co/a/b") parses as a relative URL
// with no host, so a bare host is tried with a scheme first.
function asUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  // A value that names a scheme is only ever read as an absolute URL: without
  // this, "https://" falls back to a host called "https".
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.hostname ? url : null;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(text);
    if (url.hostname) return url;
  } catch { /* a bare host is tried below */ }
  try {
    const url = new URL(`https://${text}`);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

/**
 * The hostname of `value`, lowercased, without a port or a leading `www.`;
 * null when no host can be read from it.
 */
function hostOf(value) {
  const url = asUrl(value);
  if (!url) return null;
  const host = String(url.hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return HOST_RE.test(host) ? host : null;
}

/** A short tag (a utm value or a ref), or null when it does not fit. */
function cleanTag(value, max = 64) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : null;
}

/** The tag a link was copied or shared with (`copied` or `shared`). */
function cleanVia(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return VIA_RE.test(text) ? text : null;
}

module.exports = {
  HOST_RE,
  VIA_RE,
  hostOf,
  cleanTag,
  cleanVia,
};
