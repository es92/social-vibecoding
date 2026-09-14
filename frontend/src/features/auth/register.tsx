/**
 * `#auth-register-screen` — the activation-code flow (#1080, step 2 chunk C,
 * screen 3 of 6).
 *
 * The smallest of the six: one form, one error slot, and the `#register/<code>`
 * deep link that prefills the code and moves focus to the username. The
 * markup, ids and class strings are the hand-written shell's; the inputs are
 * uncontrolled (read by ref on submit) so no `value` attribute enters the
 * prerendered document.
 *
 * The `#reg-error` slot is this screen's, and with the login screen converted
 * it is the LAST one auth-screens.js still clears on `usernode:offline-change`
 * — so that listener moves here too, and the legacy list becomes empty.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';

import { useMountedOnReveal } from '../../lib/mount-on-reveal';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  AUTH_SCREEN_IDS,
  blockedOffline,
  fetchSessionMint,
  finishLogin,
  hiddenLast,
  sessionMintFailureMessage,
  useAuthScreensPatch,
} from './shared';

/**
 * The register form's three fields, spelled as <Input> props: `w-full
 * rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300
 * dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100
 * placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none
 * focus:ring-2 focus:ring-violet-500 focus:border-transparent`. #reg-code
 * appends `font-mono` through className, where its string appends it.
 */
const AUTHFIELD = { box: 'card', hint: 'dim', ring: 'bare' } as const;
const AUTH_CARD = 'rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden';
const AUTH_ROW = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const AUTH_LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const PILL_LINK = 'flex h-11 w-full items-center justify-center rounded-full bg-white text-[16px] font-semibold text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 transition-colors';

export function RegisterScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.register, false);
  // The screen's interior mounts on its first reveal, not in the prerender —
  // see lib/mount-on-reveal.ts. AuthScreens.show() asks for it (through
  // window.UsernodeReact.mount) before it wires or reveals the screen, so the
  // hooks this component patches onto AuthScreens are installed and the
  // interior's nodes exist by the time the on-show hook runs.
  const mounted = useMountedOnReveal(AUTH_SCREEN_IDS.register);

  const [error, setError] = useState<string | null>(null);

  const code = useRef<HTMLInputElement>(null);
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);

  /**
   * `#register/<code>` deep link (the old /register.html?code=<code>). Written
   * straight to the input rather than held in state for the same reason the
   * fields are uncontrolled — and only when the field is still empty, so a
   * re-navigation cannot clobber something half-typed.
   */
  const registerOnShow = useCallback((seg?: string) => {
    if (!seg || !code.current || code.current.value) return;
    code.current.value = decodeURIComponent(seg);
    username.current?.focus();
  }, []);

  const onSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (blockedOffline(setError)) return;
    try {
      const res = await fetchSessionMint('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.current?.value.trim() || '',
          username: username.current?.value.trim() || '',
          password: password.current?.value || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed');
        return;
      }
      finishLogin();
    } catch (error) {
      setError(sessionMintFailureMessage(error));
    }
  }, []);

  const live = useRef({ registerOnShow });
  live.current = { registerOnShow };
  useAuthScreensPatch({
    _wireRegister: () => {},
    _registerOnShow: (seg?: string) => live.current.registerOnShow(seg),
  });

  /**
   * Coming back online re-enables the controls via CSS, so a stale "you're
   * offline" message would be the only thing still saying otherwise. A real
   * "code already used" stays put.
   */
  useEffect(() => {
    const onOfflineChange = (e: Event) => {
      const detail = (e as CustomEvent<{ offline?: boolean }>).detail;
      if (!detail || detail.offline !== false) return;
      setError((current) => (current && /offline/i.test(current) ? null : current));
    };
    window.addEventListener('usernode:offline-change', onOfflineChange);
    return () => window.removeEventListener('usernode:offline-change', onOfflineChange);
  }, []);

  return (
    <main
      ref={rootRef}
      id="auth-register-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll"
    >
      {mounted ? (
        <>
      <a
        href="#"
        data-auth-back=""
        className="fixed left-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
        aria-label="Back"
        onClick={(e) => {
          e.preventDefault();
          location.hash = '#landing';
        }}
      >
        <ChevronLeftIcon className="w-6 h-6" aria-hidden="true" />
      </a>
      <div className="min-h-full flex items-center justify-center">
        <div className="w-full max-w-sm px-6 py-16">
          <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-center mb-1 text-zinc-900 dark:text-zinc-100">
            Homeroom
          </h1>
          <p className="text-[15px] text-zinc-500 dark:text-zinc-400 text-center mb-2 italic">
            A place where users own and build apps together
          </p>
          <p className="text-[15px] text-zinc-500 dark:text-zinc-400 text-center mb-8">
            Create your account
          </p>
          <form id="register-form" className="space-y-4" onSubmit={onSubmit}>
            <div className={AUTH_CARD}>
            <div className={AUTH_ROW}>
              <label htmlFor="reg-code" className={AUTH_LABEL}>
                Activation Code
              </label>
              <Input
                ref={code}
                id="reg-code"
                name="code"
                type="text"
                required={true}
                autoComplete="off"
                {...AUTHFIELD}
                className="font-mono"
                placeholder="enter activation code"
              />
            </div>
            <div className={AUTH_ROW}>
              <label
                htmlFor="reg-username"
                className={AUTH_LABEL}
              >
                Username
              </label>
              <Input
                ref={username}
                id="reg-username"
                name="username"
                type="text"
                required={true}
                autoComplete="username"
                {...AUTHFIELD}
                placeholder="choose a username"
              />
            </div>
            <div className={AUTH_ROW}>
              <label
                htmlFor="reg-password"
                className={AUTH_LABEL}
              >
                Password
              </label>
              <PasswordInput
                ref={password}
                id="reg-password"
                name="password"
                required={true}
                autoComplete="new-password"
                {...AUTHFIELD}
                placeholder="choose a password"
              />
            </div>
            </div>
            <div id="reg-error" className={hiddenLast(!error, 'text-red-400 text-sm')}>
              {error}
            </div>
            <Button type="submit" layout="full" variant="pillAccent" size="pillLg" ink="solidLate">
              Register
            </Button>
          </form>
          <p className="mt-3">
            <a href="#login" className={PILL_LINK}>
              {'Already have an account? '}
              <span className="ml-1 text-violet-700 dark:text-violet-400">Log in</span>
            </a>
          </p>
        </div>
      </div>
        </>
      ) : null}
    </main>
  );
}
