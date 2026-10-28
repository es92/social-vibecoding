/**
 * Is there a viewer the platform's member APIs will answer? (QA 2026-09-24 Q35)
 *
 * The shell is one document for everybody, so every store in it is mounted on
 * the signed-out landing and in the waiting room too. A store that fetched a
 * member-only endpoint at mount (`/api/models`, `/api/agent-sessions`)
 * therefore asked on every anonymous page and
 * got a 401, and asked from the waiting room and got a 403. Each refusal is a
 * red "Failed to load resource" line in the console: four on every
 * signed-out screen, and a console error on a route fails proposal checks.
 *
 * The answer is the shell's own: `window.App.user` is set once the session is
 * known, and `hasPlatformAccess === false` is the waiting room (public/js/
 * app.js gates on exactly that, `=== false` so an older cached user without
 * the field is not locked out).
 *
 * A store that asks too early (the React tree mounts before App.init has read
 * /api/auth/me) is not refused for good: `whenPlatformViewer` runs it again
 * on `sv:authed`, which the authed boot dispatches on `document` once per
 * document and only for a released account, including a reload-free sign-in
 * and a waiting-room release. Same shape as the notifications bell and the
 * messages store, which already waited for it.
 */

export function hasPlatformViewer(): boolean {
  if (typeof window === 'undefined') return false;
  const user = window.App?.user;
  return !!user && user.hasPlatformAccess !== false;
}

/**
 * Run `fn` now when there is such a viewer, otherwise once the authed shell
 * boots. Returns a disposer for the pending listener (a no-op when `fn` has
 * already run).
 */
export function whenPlatformViewer(fn: () => void): () => void {
  if (hasPlatformViewer()) {
    fn();
    return () => {};
  }
  if (typeof document === 'undefined') return () => {};
  const onAuthed = () => {
    if (hasPlatformViewer()) fn();
  };
  document.addEventListener('sv:authed', onAuthed, { once: true });
  return () => document.removeEventListener('sv:authed', onAuthed);
}
