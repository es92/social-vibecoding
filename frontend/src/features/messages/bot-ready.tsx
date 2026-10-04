import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';

import * as api from './api';
import { botMeta } from './bot-question';
import { scopeKey, setReply } from './store';
import type { ConversationMessage, HomeroomBotAction, HomeroomBotMeta, HomeroomBotReady } from './types';

/*
 * B7: a change Homeroom bot built, ready to try, as a card in place of the
 * message's words (./message-row.tsx), which still say it for the inbox and
 * the push. Sent once its preview is up and its checks passed or were not
 * needed (services/homeroom-bot-dm.js noteChangeReady).
 *
 *   Try it            its preview, over the chat (AppView.ensureStaging);
 *   Approve           when the person's own Yes counts and is not in yet:
 *                     cast from THEIR browser, on the version the card was
 *                     sent for (api.approveChange). The bot never votes. On
 *                     a project of one person's it is the Yes that makes it
 *                     live;
 *   Change something  quotes the card in the composer, for the bot to
 *                     change it (its revise path).
 *
 * In a group the card says who else it waits on. Once they approve, here or
 * anywhere, the buttons give way to one line on every device. A version
 * that was replaced since the card was sent approves nothing: the card says
 * to try the new version first, and Approve comes back once they have.
 */

export type ReadyCardState = 'open' | 'approved' | 'stale' | 'updated' | 'closed';

/** Whether a message is a change's ready card. */
export function isReadyMessage(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  return !!meta && meta.kind === 'proposal' && !!meta.ready && !!meta.actions?.length && !message.deleted;
}

/** "Plant Pal is ready to try", or in a group "Your change to Supper Club is ready to try". */
export function readyTitle(meta: HomeroomBotMeta): string {
  const app = meta.appName || meta.appSlug || 'Your project';
  return meta.ready?.group && !meta.firstVersion ? `Your change to ${app} is ready to try` : `${app} is ready to try`;
}

/** Pure: "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Pure: who it waits on, in a group: "Waiting for approval from you and
 * @ada". Nothing on a project of one, or when their Yes is the last needed.
 */
export function waitingLine(ready: HomeroomBotReady | undefined, canApprove: boolean): string | null {
  if (!ready?.group || ready.last) return null;
  const who = [...(canApprove ? ['you'] : []), ...ready.waitingOn.map((name) => `@${name}`)];
  if (ready.more) who.push(`${ready.more} more`);
  return who.length ? `Waiting for approval from ${listWords(who)}` : null;
}

/** What the line under a card that is not open says. */
export function readyLine(state: ReadyCardState, last: boolean): string | null {
  if (state === 'approved') return last ? 'You approved it. It’s going live.' : 'You approved it.';
  if (state === 'stale') return 'This change was updated. Try the new version first.';
  if (state === 'updated') return 'This change was updated. Its newer version is below.';
  if (state === 'closed') return 'No longer needed.';
  return null;
}

export interface ReadyCardViewProps {
  meta: HomeroomBotMeta;
  state: ReadyCardState;
  /** The buttons to show: all of them when open; Try it alone when stale. */
  actions: HomeroomBotAction[];
  error?: string | null;
  busy?: boolean;
  onPress?: (action: HomeroomBotAction) => void;
}

/** One card, from its message and its state: pure, so a test can draw every state. */
export function ReadyCardView({ meta, state, actions, error = null, busy = false, onPress }: ReadyCardViewProps) {
  const canApprove = actions.some((action) => action.type === 'vote');
  const waiting = state === 'open' ? waitingLine(meta.ready, canApprove) : null;
  const line = readyLine(state, !!meta.ready?.last);
  return (
    <div
      className="mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label={readyTitle(meta)}
      data-bot-ready={state}
    >
      <div className="flex items-center gap-3">
        <IconTile size="xs" className="h-[38px] w-[38px] rounded-full bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)] dark:bg-[color:var(--brand-tint)] dark:text-[color:var(--brand-ink)]">
          <CheckIcon aria-hidden="true" />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100" data-bot-ready-title="">{readyTitle(meta)}</div>
          {meta.askedText ? <p className="line-clamp-2 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{`You asked: ${meta.askedText}`}</p> : null}
          {waiting ? <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-ready-waiting="">{waiting}</p> : null}
        </div>
      </div>
      {line ? <p className="messages-bot-answered" role="status">{line}</p> : null}
      {actions.length ? (
        <div className="messages-bot-answers" role="group" aria-label="Choices">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={busy}
              className={action.style === 'primary' || actions.length === 1 ? 'messages-bot-primary' : 'messages-bot-secondary'}
              data-bot-ready-action={action.id}
              onClick={() => onPress?.(action)}
            >
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}

/** Open a change's preview over the chat, or its page when there is no preview overlay to open. */
function tryChange(meta: HomeroomBotMeta, sessionId: number) {
  const view = typeof window !== 'undefined' ? window.AppView : null;
  if (meta.appSlug && view && typeof view.ensureStaging === 'function') {
    void view.ensureStaging(sessionId, null, null, { readOnly: false, app: { slug: meta.appSlug } });
    return;
  }
  if (meta.appSlug) window.location.hash = `#app/${encodeURIComponent(meta.appSlug)}/dev/proposals/${sessionId}`;
}

export function BotReadyCard({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const meta = botMeta(message);
  // What happened here, until the message's own update says it everywhere.
  const [approved, setApproved] = useState(false);
  const [stale, setStale] = useState<{ epoch: number | null; tried: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!meta?.ready) return null;
  const all = meta.actions || [];

  let state: ReadyCardState = 'open';
  if (approved || (meta.status === 'answered' && meta.chosen === 'approve')) state = 'approved';
  else if (meta.status === 'closed') state = meta.updated ? 'updated' : 'closed';
  else if (stale) state = 'stale';
  // Stale: Try it, and Approve back (on the version it is at now) once tried.
  const actions = state === 'open' ? all
    : state === 'stale' ? all.filter((action) => action.type === 'preview' || (stale?.tried && action.type === 'vote'))
      : [];

  async function press(action: HomeroomBotAction) {
    if (!meta) return;
    setError(null);
    if (action.type === 'preview' && action.sessionId) {
      tryChange(meta, action.sessionId);
      if (stale) setStale({ ...stale, tried: true });
      return;
    }
    if (action.type === 'reply') {
      setReply(scopeKey(conversationId, null), message);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
      });
      return;
    }
    if (action.type === 'vote' && action.sessionId) {
      setBusy(true);
      const epoch = stale ? stale.epoch : (action.epoch ?? null);
      const out = await api.approveChange(action.sessionId, epoch);
      setBusy(false);
      if (out.ok) { setApproved(true); setStale(null); return; }
      if (out.stale) { setStale({ epoch: out.epoch, tried: false }); return; }
      setError(out.error);
    }
  }

  return <ReadyCardView meta={meta} state={state} actions={actions} error={error} busy={busy} onPress={(action) => { void press(action); }} />;
}
