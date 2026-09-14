/**
 * Share dialog (#share-modal).
 *
 * The app's public URL, a copy button, and an "Open in new tab" link.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. The render output is still
 * byte-identical to what the shell shipped — same ids, same class strings,
 * same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html in
 * this commit are the proof.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `AppView.openShareModal` / `.closeShareModal` / `.copyShareUrl` were
 * public/js/app-view.js:13170-13218; the close-button and backdrop listeners
 * (including the `modalDismissGuarded` ghost-click check, which lives in
 * `useDialog` now) were public/js/app.js's `bindEvents`.
 * `AppView.openShareModal()` survives as a one-line forward — the drawer's
 * Share row and the app-view header both call it by name.
 *
 * `resolveDevHost` is reached as a global for the same reason every other
 * legacy name here is: public/js/dev-host.js is a classic script that
 * publishes `window.resolveDevHost`, and a bundle module cannot import it.
 * It rewrites `http://localhost:<port>` URLs to whatever hostname the browser
 * is actually on, so a phone on the LAN gets a link that resolves.
 *
 * The URL field stays UNCONTROLLED (a ref, not `value`): a controlled input
 * renders a `value` attribute in the prerender pass and this document is
 * compared against the hand-written shell attribute for attribute.
 */

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { ArrowRightIcon, XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

import { useDialog } from './use-dialog';

export function ShareDialog() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [href, setHref] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy');
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dialog = useDialog('share', {
    onOpen: () => {
      const raw = (window.AppView?.appData?.url as string) || '';
      const url = raw && window.resolveDevHost ? window.resolveDevHost(raw) : raw;
      if (inputRef.current) inputRef.current.value = url;
      setHref(url);
      setCopyLabel('Copy');
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    },
    onClose: () => {
      if (flashRef.current) clearTimeout(flashRef.current);
      flashRef.current = null;
      setCopyLabel('Copy');
    },
  });

  // Verbatim from AppView.copyShareUrl: try the async clipboard first, fall
  // back to select + execCommand for browsers/contexts where
  // navigator.clipboard isn't available (e.g. http: localhost in some
  // browsers), then flash the outcome on the button for 1.5s.
  async function copy() {
    const input = inputRef.current;
    const url = input?.value || '';
    if (!url) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      /* falls through to the execCommand path below */
    }
    if (!ok && input) {
      try {
        input.focus();
        input.select();
        ok = document.execCommand('copy');
      } catch {
        /* both paths refused — say so on the button */
      }
    }
    setCopyLabel(ok ? 'Copied!' : 'Copy failed');
    if (flashRef.current) clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setCopyLabel('Copy'), 1500);
  }

  return (
    <DialogRoot
      id="share-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="md" relative>
        <button
          id="share-close"
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
          aria-label="Close share"
          onClick={() => dialog.close()}
        >
          <XIcon className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100">
          Share this app
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          Anyone with this link can open the app outside the Homeroom platform. Whether they need to log in is up to the app; most public apps work for anonymous viewers.
        </p>
        <div className="flex gap-2">
          <Input
            id="share-url-input"
            ref={inputRef}
            type="text"
            readOnly={true}
            width="flex1"
            mono
            aria-label="Share URL"
          />
          <Button id="share-copy-btn" className="whitespace-nowrap" onClick={copy}>
            {copyLabel}
          </Button>
        </div>
        <div className="mt-4 flex justify-end">
          <a
            id="share-open-link"
            href={href || '#'}
            target="_blank"
            rel="noopener"
            className="text-sm text-violet-700 hover:text-violet-400 transition-colors inline-flex items-center gap-1 dark:text-violet-400"
          >
            Open in new tab
            <ArrowRightIcon className="w-4 h-4" />
          </a>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
