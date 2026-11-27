import { useEffect, useRef, type Ref } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { loadQRCode } from '../../lib/qr-code';
import { useSheet } from '../../lib/sheet';
import type { StoreLink } from './ask-state';

/**
 * The notification ask's "Get the app", on a computer (./notify-ask.tsx).
 *
 * A computer cannot install a phone app, so this shows a code to scan: it
 * opens `/get-app` (routes/public-api.js), which sends the phone that scans
 * it to its own store. Under it, each store's link, for whoever would rather
 * open the store on the phone themselves.
 *
 * Presented as the install banner's "How" sheet is
 * (../mobile-install/install-steps-sheet.tsx), by the Sheet (lib/sheet.ts):
 * the native kit's `sheet` when there is one, and a CSS sheet over a scrim
 * when not. Back, Escape, the scrim, ✕ and Done close it.
 */
export function GetAppSheet({ links, onClose }: { links: StoreLink[]; onClose: () => void }) {
  const done = useRef<HTMLButtonElement | null>(null);
  const { panelRef: panel, adopted, scrimProps } = useSheet({
    kind: 'sheet',
    onClose,
    initialFocus: () => done.current,
  });

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={adopted ? 'contents' : 'fixed inset-0 z-[70] bg-black/60 flex items-end justify-center md:items-center'}
      {...scrimProps}
    >
      <div
        ref={panel}
        id="notify-ask-get-app"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notify-ask-get-app-title"
        // A constant, as the install sheet's is: the kit writes
        // `platform-sheet-adopted` to this node.
        className="w-full max-w-md rounded-t-[20px] md:rounded-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] flex flex-col"
      >
        <GetAppContent links={links} onClose={onClose} doneRef={done} />
      </div>
    </div>,
    document.body,
  );
}

/** The address the code opens: this platform's `/get-app`. */
export function getAppUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/get-app`;
}

/** What the sheet shows, apart from how it is presented, so a test can draw it. */
export function GetAppContent({ links, onClose, doneRef }: {
  links: StoreLink[];
  onClose: () => void;
  doneRef?: Ref<HTMLButtonElement>;
}) {
  const t = useMessages('notifications');
  // The store names are the install banner's (../mobile-install/detect.ts storeLabel).
  const tStore = useMessages('agent');
  const code = useRef<HTMLDivElement | null>(null);
  // The QR library writes its own canvas or image into this node: the one
  // element here React does not own, empty in render and filled from an
  // effect (as the wallet's receive code is).
  useEffect(() => {
    const el = code.current;
    if (!el) return;
    // Loaded when the sheet opens, not at boot (lib/qr-code.ts).
    let live = true;
    loadQRCode().then((QR) => {
      if (!live) return;
      el.textContent = '';
      new QR(el, { text: getAppUrl(window.location.origin), width: 176, height: 176 });
    }).catch(() => { /* no code: the store links are under it */ });
    return () => { live = false; };
  }, []);
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <h2 id="notify-ask-get-app-title" className="flex-1 min-w-0 text-[17px] font-bold leading-snug text-zinc-900 dark:text-zinc-100">
          {t('notifications:ask.sheet.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('core:common.close')}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
        >
          <XIcon className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-3 rounded-[20px] bg-white p-4 dark:bg-zinc-900">
        <div ref={code} role="img" aria-label={t('notifications:ask.sheet.codeLabel')} className="rounded bg-white p-2" />
        <p className="text-center text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{t('notifications:ask.sheet.scan')}</p>
      </div>
      {links.length ? (
        <>
          <p className="mt-4 pb-1.5 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t('notifications:ask.sheet.or')}</p>
          <ul className="flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.os}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-notify-ask-store={link.os}
                  className="text-[15px] font-medium text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
                >
                  {tStore(link.label)}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Button ref={doneRef} type="button" layout="full" className="mt-4 min-h-[44px]" onClick={onClose}>
        {t('core:common.done')}
      </Button>
    </>
  );
}
