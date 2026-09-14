/**
 * `#auth-waiting-screen` — the platform-access gate (#1080, step 2 chunk C,
 * screen 4 of 6).
 *
 * An authed session WITHOUT `hasPlatformAccess` lands here instead of the
 * shell. The screen polls `/api/auth/me` every 30s and, the moment access is
 * granted, boots the full shell in place — the same reload-free handover login
 * uses, so a released user never has to know to refresh.
 *
 * ── The poll is not a mount effect ────────────────────────────────────
 *
 * It starts from `_waitingOnShow()` and stops from `_stopWaitingPoll()`, both
 * of which the router calls — `show()` stops it when navigating away from
 * `waiting`, and `hideAll()` stops it on the way into the authed shell. That
 * lifecycle is the router's, not the component's: this screen element stays
 * mounted for the whole session (all six do), so a mount effect would start
 * the poll for every visitor who never sees this screen. So the timer lives in
 * a ref driven by the patched hooks, and the only mount effect is the one that
 * clears it on unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AUTH_SCREEN_IDS, fx, legacy, useAuthScreensPatch } from './shared';

/** How often to re-check for release. */
const POLL_MS = 30000;

interface MeUser {
  username?: string;
  hasPlatformAccess?: boolean;
}

export function WaitingScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.waiting, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.waiting);

  const [who, setWho] = useState('');
  const [checkState, setCheckState] = useState('');

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopWaitingPoll = useCallback(() => {
    if (timer.current === null) return;
    clearInterval(timer.current);
    timer.current = null;
  }, []);

  const check = useCallback(async () => {
    const w = legacy();
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        // Session died while waiting — back to the login screen.
        stopWaitingPoll();
        if (w.App) {
          if (typeof w.App.enterAnonymous === 'function') await w.App.enterAnonymous();
        }
        location.hash = '#login';
        return;
      }
      const data = await res.json();
      const user: MeUser | undefined = data && data.user;
      if (!user) return;
      setWho(user.username || '');
      if (user.hasPlatformAccess) {
        // Released! Boot the full shell in place — same reload-free path as
        // login, including the deep link the visitor originally arrived with.
        stopWaitingPoll();
        const host = w.AuthScreens;
        const target = (host?._pendingHash as string) || '';
        if (host) host._pendingHash = '';
        const targetUrl = typeof host?.deepLinkUrl === 'function'
          ? host.deepLinkUrl(target) : '/' + target;
        history.replaceState(null, '', targetUrl);
        fx(() => {
          (host?.hideAll as undefined | (() => void))?.();
          w.App?.enterAuthed?.(user);
        }, 'pop');
        return;
      }
      setCheckState('Last checked ' + new Date().toLocaleTimeString());
    } catch {
      setCheckState('Connection issue, will retry');
    }
  }, [stopWaitingPoll]);

  const startWaitingPoll = useCallback(() => {
    if (timer.current !== null) return;
    void check();
    timer.current = setInterval(() => void check(), POLL_MS);
  }, [check]);

  const waitingOnShow = useCallback(() => {
    setWho(legacy().App?.user?.username || '');
    startWaitingPoll();
  }, [startWaitingPoll]);

  const onLogout = useCallback(async () => {
    const w = legacy();
    // Settings.logout commits web logout/cache cleanup before its final hard
    // native boundary (or hard-navigates in a regular browser). Keep polling
    // alive if that preflight or web logout fails.
    if (w.Settings && typeof w.Settings.logout === 'function') {
      w.Settings.logout();
      return;
    }
    stopWaitingPoll();
    // Same sweep and same landing as Settings.logout (#1524): the wider
    // _dropCachedSession so no remembered header survives the sign-out, and a
    // REPLACE to a bare '/' so Back cannot restore the signed-in document and
    // no leftover query or fragment turns the landing page into a sign-in form.
    try {
      w.App?._dropCachedSession?.();
    } catch {
      /* ignore */
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* ignore */
    }
    window.location.replace('/');
  }, [stopWaitingPoll]);

  const live = useRef({ waitingOnShow, startWaitingPoll, stopWaitingPoll });
  live.current = { waitingOnShow, startWaitingPoll, stopWaitingPoll };
  useAuthScreensPatch({
    _wireWaiting: () => {},
    _waitingOnShow: () => live.current.waitingOnShow(),
    // show() and hideAll() both drive these directly, so they stay part of
    // the screen's public surface rather than becoming private helpers.
    _startWaitingPoll: () => live.current.startWaitingPoll(),
    _stopWaitingPoll: () => live.current.stopWaitingPoll(),
  });

  // The only mount-scoped concern: never leave an interval behind.
  useEffect(() => () => stopWaitingPoll(), [stopWaitingPoll]);

  return (
    <main
      ref={rootRef}
      id="auth-waiting-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
      <div className="min-h-full flex items-center justify-center">
        <div className="w-full max-w-sm px-6 py-16 text-center">
          <h1 className="text-[28px] font-extrabold leading-tight tracking-tight mb-1 text-zinc-900 dark:text-zinc-100">
            You're in the queue
          </h1>
          <p className="text-[15px] text-zinc-500 dark:text-zinc-400 mb-8 italic">
            Homeroom
          </p>
          <div className="rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left space-y-3">
            <p className="text-[17px] leading-snug text-zinc-900 dark:text-zinc-100">
              {'Your account '}
              <span id="waiting-who" className="font-semibold">
                {who}
              </span>
              {" doesn't have platform access yet. We let people in from the waitlist in batches. You'll get in automatically when your turn comes."}
            </p>
            <p className="text-[15px] text-zinc-500 dark:text-zinc-400">
              This page checks for you every so often; you can also just come back later.
            </p>
            <p id="waiting-check-state" className="text-[15px] text-zinc-500 dark:text-zinc-500">
              {checkState}
            </p>
          </div>
          <div className="mt-6 space-y-3">
            <a
              href="#landing"
              className="flex h-12 w-full items-center justify-center rounded-full bg-violet-600 hover:bg-violet-500 px-5 text-[17px] font-semibold transition-colors text-white"
            >
              Browse public apps while you wait
            </a>
            <button
              id="waiting-logout"
              className="flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              onClick={onLogout}
            >
              Log out
            </button>
          </div>
        </div>
      </div>
        </>
      ) : null}
    </main>
  );
}
