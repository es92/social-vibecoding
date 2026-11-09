/**
 * #6248: A REQUEST DRAFT, READ BEFORE IT IS FILED. When Homeroom bot drafts
 * a request for somebody, the card under its reply waits with File it and
 * Not now. That card could not be opened until the request was filed, so the
 * draft could not be read in full: the message clips its details at 1200
 * characters (services/homeroom-bot-mayor.js). The card now opens this pane
 * in the AI tab's own column, beside the chat (../ai/preview.ts), the place
 * a design's preview opens.
 *
 * It is read only. The card keeps File it and Not now; the pane has nothing
 * to press but its × (or, on a phone, the back arrow to the chat).
 *
 * The whole draft is read from the saved row (GET
 * /api/conversations/homeroom-bot/actions/:actionId/draft). Until it comes,
 * and when it cannot be read, the message's own copy is shown: its title,
 * project and clipped details. Nothing loads in the first render, so the
 * server's markup and the first client render agree.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { ChevronLeftIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import * as api from './api';
import { MessageMarkdown } from './format';

const ICON = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800';

/** What the message itself says about the draft, shown until the saved row is read. */
export interface DraftCopy {
  title: string;
  project: string;
  details: string;
  appSlug: string | null;
}

export function RequestDraftPane({ actionId, copy, seq = 0, onClose, closeAs = 'close' }: {
  actionId: number;
  copy: DraftCopy;
  /** Each open's count, so opening the same draft again reads it again. */
  seq?: number;
  /** The tab's own column: this closes the preview. */
  onClose?: () => void;
  /** × beside the chat; a back arrow to it where the pane is the whole screen. */
  closeAs?: 'close' | 'back';
}): ReactNode {
  const t = useMessages('messages');
  const [draft, setDraft] = useState<api.RequestDraft | null>(null);

  useEffect(() => {
    let live = true;
    setDraft(null);
    api.readRequestDraft(actionId).then((read) => { if (live) setDraft(read); }, () => { /* the message's copy stays */ });
    return () => { live = false; };
  }, [actionId, seq]);

  const title = draft?.title || copy.title;
  const project = draft?.app.name || copy.project;
  // The saved row's whole description; the message's clipped one until it comes.
  const details = draft?.details || copy.details;
  const appSlug = draft?.app.slug || copy.appSlug;
  return (
    <section className="messages-design-pane" data-request-draft-pane={actionId} aria-label={t('messages:draft.pane.label')}>
      <header className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        {onClose && closeAs === 'back' ? (
          <button type="button" className={ICON} onClick={onClose} aria-label={t('messages:draft.pane.back')} title={t('messages:draft.pane.back')} data-draft-close="back">
            <ChevronLeftIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-[12rem] flex-1">
          <div className="truncate text-[15px] font-[650] text-zinc-900 dark:text-zinc-100" data-draft-title="">{title}</div>
          <div className="mt-0.5 truncate text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:draft.pane.sub', { project })}</div>
        </div>
        {onClose && closeAs === 'close' ? (
          <button type="button" className={ICON} onClick={onClose} aria-label={t('messages:draft.pane.close')} title={t('messages:draft.pane.close')} data-draft-close="close">
            <XIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <MessageMarkdown content={details} appSlug={appSlug} />
        {draft?.footer ? (
          <>
            <hr className="my-3.5 border-0 border-t border-zinc-200 dark:border-zinc-800" />
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400" data-draft-footer="">{draft.footer}</p>
          </>
        ) : null}
        <p className="mt-3.5 rounded-xl bg-zinc-100 px-3 py-2.5 text-[13px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" role="note">
          {t('messages:draft.pane.nothingFiled')}
        </p>
      </div>
    </section>
  );
}
