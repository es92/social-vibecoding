/**
 * An admin's invite link to Homeroom itself: `/welcome/<code>`
 * (src/routes/access-links.js, src/services/access-links.js).
 *
 * An admin makes one per person in Admin › Activation codes. Opened signed
 * out, it is the landing with the sign-up sheet already up, titled as an
 * invitation and saying that the link skips the waitlist (./landing.tsx).
 * The page left the code in an HttpOnly cookie, so the account the sheet
 * makes or signs in to is let in by the server; nothing here carries it.
 *
 * A link that was used already, or never existed, opens the same sheet
 * saying so: the person it let in can still sign in from it, and anybody
 * else learns to ask for a new one before they make an account that waits.
 */

import { useEffect, useState } from 'react';

export type AccessLinkPreview = { live: boolean; reason: 'used' | 'unknown' | null };

/** The code of a `/welcome/<code>` path, or null. Same shape as the server's. */
export function accessCodeFrom(pathname: string): string | null {
  const m = /^\/welcome\/([A-Za-z0-9_-]{6,32})\/?$/.exec(pathname || '');
  return m ? m[1] : null;
}

/** Whether this is such a link's path at all, a code or not. */
export function onAccessLink(pathname: string): boolean {
  return /^\/welcome\/[^/]+\/?$/.test(pathname || '');
}

/**
 * The link's preview, read once after mount (never in the prerender, which
 * has no location): null until it is known, and on any other path.
 */
export function useAccessLinkPreview(): AccessLinkPreview | null {
  const [preview, setPreview] = useState<AccessLinkPreview | null>(null);
  useEffect(() => {
    if (!onAccessLink(location.pathname)) return undefined;
    const code = accessCodeFrom(location.pathname);
    if (!code) { setPreview({ live: false, reason: 'unknown' }); return undefined; }
    let alive = true;
    fetch(`/api/public/access-links/${encodeURIComponent(code)}`, { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((body: AccessLinkPreview) => {
        if (alive && body && typeof body.live === 'boolean') setPreview(body);
      })
      // A preview that cannot be read opens nothing: the landing is as it
      // always is, and its own Join still makes the account.
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return preview;
}
