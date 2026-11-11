/**
 * SEE WHAT VISITORS SEE: a member's look at their project's signed-out page,
 * from the hub's ⋯ (../dev-board/actions-row.tsx). Members never meet the
 * page a visitor decides on (its preview loop, its featured illustration,
 * what is up for a vote in its compact rows), so this is how they check
 * what they are voting changes into.
 *
 * It draws the visitor's page itself: the signed-out site's bar (the
 * wordmark, Sign in and Sign up) and ./guest-project.tsx GuestProject, read
 * from the same public overview a visitor's browser reads, so nothing here
 * can show a member more than a visitor gets. Over it, one bar of its own
 * says what this is and has the way back to the hub; Escape goes back too.
 *
 * READ ONLY. The member stays signed in, and pressing what would ask a
 * visitor to sign in (Join, Vote, Sign up, Sign in) only says so in a toast.
 * Open opens the app, which is the member's to open anyway.
 *
 * A layer over the page, not an address: the hub stays where it was
 * underneath, so Back to hub returns to it exactly. It mounts only on the
 * ⋯ row's press, never in the prerender.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EyeIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { type GuestApp, type GuestOverview, fetchOverview } from './guest-data';
import { GuestProject } from './guest-project';

function inert(): void {
  (window as any).PlatformUI?.toast?.(translate('project:visitorView.inert'));
}

export function VisitorView({ slug, onClose }: { slug: string; onClose: () => void }) {
  const t = useMessages('project');
  const ta = useMessages('auth');
  const [overview, setOverview] = useState<GuestOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading');
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    void fetchOverview(slug).then((o) => {
      if (!live) return;
      setOverview(o);
      setState(o ? 'ready' : 'none');
    });
    return () => { live = false; };
  }, [slug]);

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (app: GuestApp) => {
    onClose();
    (window as any).App?.openAppTab?.(app.slug, 'app');
  };

  return (
    <div
      data-visitor-view={slug}
      role="dialog"
      aria-modal="true"
      aria-label={t('project:visitorView.title')}
      className="fixed inset-0 z-[70] flex flex-col bg-white dark:bg-zinc-950"
      style={{ background: 'var(--home-wallpaper)' }}
    >
      <div
        data-visitor-view-bar=""
        className="un-safe-top-extend flex shrink-0 items-center gap-3 bg-white px-4 pb-2 pt-2 shadow-[inset_0_-1px_0_var(--app-sheet-line)] dark:bg-zinc-900"
      >
        <EyeIcon className="h-5 w-5 shrink-0 text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{t('project:visitorView.title')}</div>
          <div className="truncate text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{t('project:visitorView.sub')}</div>
        </div>
        <Button
          ref={backRef}
          type="button"
          variant="pillAccent"
          size="none"
          ink="solid"
          data-visitor-view-back=""
          className="min-h-11 shrink-0 px-4 text-[15px] font-semibold"
          onClick={onClose}
        >
          {t('project:visitorView.back')}
        </Button>
      </div>
      <div data-visitor-view-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        {/* The signed-out site's bar, as a visitor's landing draws it. */}
        <div className="flex items-center gap-3 px-4 pb-4 pt-2 shadow-[inset_0_-1px_0_var(--app-sheet-line)] md:px-[max(1rem,calc((100%_-_72rem)/2_+_1rem))]">
          <div className="min-w-0 flex-1">
            <Wordmark className="inline-block h-7 w-auto align-middle text-zinc-950 dark:text-white" title="Homeroom" />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="un-touch-target -my-2 min-h-11 rounded-full px-2 text-[15px] font-semibold text-zinc-950 hover:text-zinc-600 dark:text-white dark:hover:text-zinc-300"
              onClick={inert}
            >
              {ta('auth:guest.header.signIn')}
            </button>
            <Button
              type="button"
              variant="pillAccent"
              size="none"
              ink="solid"
              className="un-touch-target -my-2 min-h-11 items-center justify-center px-3.5 text-[15px] font-semibold"
              onClick={inert}
            >
              {ta('auth:guest.header.signUp')}
            </Button>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-col pb-[34px]">
          {state === 'ready' && overview ? (
            <GuestProject
              app={overview.app}
              initialOverview={overview}
              preview
              onIntent={inert}
              onOpenInside={open}
              onShare={inert}
              onAllCommunities={inert}
            />
          ) : (
            <p data-visitor-view-state={state} className="px-5 pt-8 text-[15px] text-zinc-500 dark:text-zinc-400">
              {state === 'none' ? t('project:visitorView.unavailable') : ta('auth:guest.project.loading')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
