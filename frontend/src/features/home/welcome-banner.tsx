import { useCallback, useEffect, useRef, useState } from 'react';

import { XIcon } from '@/components/ui/icons';
import { useHiddenClass } from '../../lib/legacy-dom';

/**
 * `#home-welcome` — the once-per-account explainer at the top of Home (#1561).
 *
 * The report: "after you sign in the first time, we should have some kind of
 * welcome banner that you can dismiss, that explains what is going on". A new
 * account lands on a launcher grid of apps somebody else made, with no
 * statement anywhere of what the place IS — that every app here is changed by
 * the people using it, and that changes ship by a group vote. Everything on
 * the screen assumes you already know.
 *
 * ── "First login", without asking the server ───────────────────────────
 *
 * Shown until dismissed, once per account on this device. That is deliberately
 * NOT "the account is less than N days old": the platform does not publish a
 * creation date to the client, and a rule that needs one would mean a new API
 * field for a banner. "You have not dismissed this yet" is the same thing for
 * a new account, and it is also the right answer for an existing one, who has
 * equally never been told.
 *
 * The key carries the user id, so two accounts on one device each get their
 * own answer and signing out of one does not silence the other.
 *
 * ── The island rules ───────────────────────────────────────────────────
 *
 * The strip is ALWAYS in the document and starts `hidden`, exactly like
 * `#mobile-install-banner`: the first render must reproduce the prerendered
 * markup byte for byte (AGENTS.md), and the viewer is not known at prerender
 * time. Visibility is toggled through a ref, never through a rendered
 * `className` — see lib/legacy-dom.ts.
 *
 * Every storage access is wrapped: Safari throws on storage in private mode,
 * and a banner is not worth a boot error.
 */

const KEY_PREFIX = 'usernode:home-welcome-dismissed:';

function keyFor(userId: number | null): string | null {
  return userId == null ? null : `${KEY_PREFIX}${userId}`;
}

function readDismissed(userId: number | null): boolean {
  const key = keyFor(userId);
  if (!key) return true; // Nobody to welcome yet.
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Storage denied: show it every visit rather than never. The × still
    // hides it for this one, which is the graceful half of the failure.
    return false;
  }
}

function writeDismissed(userId: number | null): void {
  const key = keyFor(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* A dismissal that cannot be persisted still hides the strip for now. */
  }
}

function currentUserId(): number | null {
  const app = (window as { App?: { user?: { id?: number } | null } }).App;
  const id = app && app.user ? app.user.id : null;
  return typeof id === 'number' ? id : null;
}

export function WelcomeBanner() {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);

  // Resolved in an effect, never during render: `App.user` is a classic-script
  // global that is only populated once the session has been read, which is
  // after hydration.
  useEffect(() => {
    const id = currentUserId();
    setUserId(id);
    setShow(id != null && !readDismissed(id));
  }, []);

  useHiddenClass(ref, !show);

  const dismiss = useCallback(() => {
    writeDismissed(userId);
    setShow(false);
  }, [userId]);

  return (
    <div
      ref={ref}
      id="home-welcome"
      className="hidden mx-3 mb-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Welcome to Homeroom
          </div>
          {/*
              What the screen does not otherwise say. Two sentences: what the
              apps are, and what you can do about them. The vote is the part
              that surprises people, so it is named rather than implied.
          */}
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            Every app here is built and changed by the people using it. Open
            one, send feedback from the Improve button, or propose a change of
            your own. Nothing ships until the group votes it in.
          </p>
        </div>
        <button
          id="home-welcome-dismiss"
          type="button"
          onClick={dismiss}
          aria-label="Dismiss the welcome message"
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
        >
          <XIcon className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
